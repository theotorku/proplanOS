"""
ProPlan Agent API — FastAPI layer for the orchestrator.

Endpoints:
    POST /agent/run                         — Run the orchestrator with a user request
    GET  /leads                             — List leads (with optional min_score filter)
    GET  /leads/export.csv                  — Download leads as CSV (same filters)
    POST /campaigns                         — Create a new campaign
    GET  /campaigns                         — List all campaigns
    GET  /campaigns/export.csv              — Download campaigns as CSV
    POST /integrations/slack/{user_id}/test — Send a Slack test ping
    POST /integrations/slack/{user_id}/leads — Send a lead digest to Slack
    GET  /health                            — Health check
"""

from fastapi import FastAPI, HTTPException, Query, Depends, Security, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.security.api_key import APIKeyHeader
from pydantic import BaseModel, Field
from typing import Any, Dict, List, Optional, Sequence
import csv
import io
import json
import uuid
import time
import os
import logging
from datetime import datetime, timezone

try:
    import httpx
except ImportError:
    httpx = None  # Slack endpoints will 501 if the package is missing.

from proplanOrchestrator import (
    Orchestrator, Tool, SalesAgent, MarketingAgent, SupportAgent, OpsAgent,
    SecurityPolicy, find_leads_tool, generate_copy_tool, search_knowledge_base,
    schedule_task, run_workflow,
    FindLeadsSchema, GenerateCopySchema, SearchKnowledgeBaseSchema,
    ScheduleTaskSchema, RunWorkflowSchema
)
from database import get_database, LeadModel, CampaignModel, AgentSessionModel, BusinessProfileModel, extract_leads_from_memory
from llm import AnthropicPlannerProvider, AnthropicAgentProvider
from chat_routes import router as chat_router

try:
    from tasks import celery_app, run_orchestrator
except ImportError:
    celery_app = None

# -----------------------------
# Pydantic Models
# -----------------------------


class AgentRunRequest(BaseModel):
    """Request body for POST /agent/run."""
    user_id: str = Field(..., description="ID of the requesting user")
    request: str = Field(...,
                         description="Natural-language request for the agent system")
    business_context: Optional[str] = Field(
        None, description="Business profile context injected into every agent run")


class AgentRunDispatchResponse(BaseModel):
    """Response body for POST /agent/run (async dispatch)."""
    status: str
    run_id: str


class AgentQueuedResponse(BaseModel):
    """Response when a run is queued asynchronously."""
    status: str
    task_id: str


class AgentStatusResponse(BaseModel):
    """Response when polling an async run."""
    status: str
    result: Optional[Dict[str, Any]] = None


class CampaignCreateRequest(BaseModel):
    """Request body for POST /campaigns."""
    name: str = Field(..., min_length=1, description="Campaign name")
    status: str = Field(default="draft", description="Campaign status")


class OnboardScanRequest(BaseModel):
    """Request body for POST /onboard/scan."""
    url: str = Field(..., min_length=1, description="Business website URL")


class OnboardReview(BaseModel):
    author: str
    rating: int
    text: str
    when: Optional[str] = None


class OnboardScanResponse(BaseModel):
    """Result of an onboarding URL scan. Any field may be empty — the UI
    exposes inline edit controls so the operator can correct / fill gaps."""
    company: Optional[str] = None
    url: str
    owner: Optional[str] = None
    location: Optional[str] = None
    vertical: Optional[str] = None
    services: Optional[str] = None
    years_operating: Optional[str] = None
    review: Optional[OnboardReview] = None


class OnboardPrefillResponse(BaseModel):
    """Pre-seeded onboarding state handed to a concierge-pilot customer."""
    token: str
    url: Optional[str] = None
    company: Optional[str] = None
    vertical: Optional[str] = None
    goals: Optional[List[str]] = None
    integrations: Optional[List[str]] = None


# -----------------------------
# Database Connection
# -----------------------------

db = get_database()

# -----------------------------
# Run Status Store
# -----------------------------
# Runs are persisted to the agent_sessions table keyed by run_id. Dispatch
# inserts a row with status="running"; the background task updates the same
# row on completion. Polling reads straight from the DB, so the status
# survives function cold-starts and is visible across workers.


def _db_backend_name() -> str:
    """Return "supabase" or "memory" so callers can see which store is live."""
    from database import SupabaseDatabase
    return "supabase" if isinstance(db, SupabaseDatabase) else "memory"


def _run_orchestrator_bg(run_id: str, request: str, business_context: Optional[str], user_id: str) -> None:
    """Background task: run orchestrator and update the run's agent_sessions row."""
    persistence_errors: List[Dict[str, Any]] = []
    leads_extracted = 0
    leads_saved = 0

    try:
        orchestrator = create_orchestrator()
        result = orchestrator.run(request, business_context=business_context)

        extracted = extract_leads_from_memory(result.get("memory", []))
        leads_extracted = len(extracted)
        for idx, lead in enumerate(extracted):
            try:
                db.create_lead(lead)
                leads_saved += 1
            except Exception as e:
                logging.error(
                    "Lead persistence failed (run=%s lead_idx=%d backend=%s): %s",
                    run_id, idx, _db_backend_name(), e, exc_info=True,
                )
                persistence_errors.append({
                    "target": "lead",
                    "index": idx,
                    "error_type": type(e).__name__,
                    "message": str(e),
                })

        session_status = "completed" if result["status"] == "goal_met" else "failed"
        final = {
            "status": result["status"],
            "run_id": result["run_id"],
            "user_id": user_id,
            "total_cost": result["total_cost"],
            "cost_breakdown": result["cost_breakdown"],
            "memory": result["memory"],
            "persistence": {
                "backend": _db_backend_name(),
                "leads_extracted": leads_extracted,
                "leads_saved": leads_saved,
                "session_logged": True,
                "errors": persistence_errors,
            },
        }
        try:
            db.update_run_session(
                run_id,
                status=session_status,
                output_data=final,
                cost_usd=result["total_cost"],
                completed_at=datetime.now(timezone.utc).isoformat(),
            )
        except Exception as e:
            logging.error(
                "update_run_session failed (run=%s backend=%s): %s",
                run_id, _db_backend_name(), e, exc_info=True,
            )

    except Exception as e:
        logging.error("Background run %s failed: %s", run_id, e, exc_info=True)
        try:
            db.update_run_session(
                run_id,
                status="failed",
                output_data={"error": str(e)},
                completed_at=datetime.now(timezone.utc).isoformat(),
            )
        except Exception as inner:
            logging.error("update_run_session (failure path) also failed for run=%s: %s", run_id, inner)


# -----------------------------
# Orchestrator Setup
# -----------------------------

def create_orchestrator() -> Orchestrator:
    """Create and configure the orchestrator with default tools and agents."""
    api_key = os.environ.get("ANTHROPIC_API_KEY")

    planner_llm = AnthropicPlannerProvider(api_key=api_key) if api_key else None
    orchestrator = Orchestrator(
        security_policy=SecurityPolicy.allow_all(),
        planner_llm=planner_llm
    )

    orchestrator.register_tool(Tool(
        name="find_leads_tool",
        schema=FindLeadsSchema,
        function=find_leads_tool,
        cost_estimate=0.02
    ))
    orchestrator.register_tool(Tool(
        name="generate_copy_tool",
        schema=GenerateCopySchema,
        function=generate_copy_tool,
        cost_estimate=0.01
    ))
    orchestrator.register_tool(Tool(
        name="search_knowledge_base",
        schema=SearchKnowledgeBaseSchema,
        function=search_knowledge_base,
        cost_estimate=0.005
    ))
    orchestrator.register_tool(Tool(
        name="schedule_task",
        schema=ScheduleTaskSchema,
        function=schedule_task,
        cost_estimate=0.005
    ))
    orchestrator.register_tool(Tool(
        name="run_workflow",
        schema=RunWorkflowSchema,
        function=run_workflow,
        cost_estimate=0.01
    ))

    def get_agent_llm(name: str, tools: str):
        return AnthropicAgentProvider(api_key, name, tools) if api_key else None

    orchestrator.register_agent(
        SalesAgent, llm_provider=get_agent_llm("sales", "find_leads_tool"))
    orchestrator.register_agent(MarketingAgent, llm_provider=get_agent_llm(
        "marketing", "generate_copy_tool"))
    orchestrator.register_agent(SupportAgent, llm_provider=get_agent_llm(
        "support", "search_knowledge_base"))
    orchestrator.register_agent(OpsAgent, llm_provider=get_agent_llm(
        "ops", "schedule_task, run_workflow"))

    return orchestrator


# -----------------------------
# Authentication
# -----------------------------

_API_SECRET_KEY = os.environ.get("API_SECRET_KEY")
_api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


async def verify_api_key(api_key: Optional[str] = Security(_api_key_header)):
    """
    Validate the X-API-Key header against the API_SECRET_KEY env var.
    If API_SECRET_KEY is not set, the check is skipped (development mode).
    """
    if _API_SECRET_KEY and api_key != _API_SECRET_KEY:
        raise HTTPException(
            status_code=403, detail="Invalid or missing API key.")


# -----------------------------
# FastAPI App
# -----------------------------

app = FastAPI(
    title="ProPlan Agent API",
    description="AI Agent Operating System for local businesses — sales, marketing, support, and operations automation.",
    version="2.0.0",
)

# CORS — restrict origins via ALLOWED_ORIGINS env var (comma-separated).
# Defaults to localhost dev server. Never use wildcard with credentials.
_raw_origins = os.environ.get(
    "ALLOWED_ORIGINS",
    "http://localhost:5173,http://127.0.0.1:5173",
)
_allowed_origins = [o.strip() for o in _raw_origins.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    # Let the browser read the filename on CSV downloads; without this the
    # frontend falls back to its generic stem instead of the timestamped name.
    expose_headers=["Content-Disposition"],
)

# Mount the public chat router. Its endpoints live under /agent/chat/* and
# are intentionally unauthenticated (abuse is controlled by per-IP and
# per-conversation rate limits inside chat_routes.py).
app.include_router(chat_router)


@app.get("/health", tags=["System"])
def health_check():
    """Health check endpoint. Reports DB backend so the UI can warn on in-memory mode."""
    return {
        "status": "healthy",
        "timestamp": time.time(),
        "db_backend": _db_backend_name(),
    }


@app.post("/agent/run", response_model=AgentRunDispatchResponse, tags=["Agent"], dependencies=[Depends(verify_api_key)])
def agent_run(body: AgentRunRequest, background_tasks: BackgroundTasks):
    """
    Dispatch an orchestrator run asynchronously.

    Returns immediately with {run_id, status: "running"}.
    Poll GET /agent/run/status/{run_id} for the result.
    """
    run_id = str(uuid.uuid4())
    try:
        db.create_run_session(AgentSessionModel(
            run_id=run_id,
            user_id=body.user_id,
            agent_type="orchestrator",
            status="running",
            input_data={"user_id": body.user_id, "request": body.request},
            started_at=datetime.now(timezone.utc).isoformat(),
        ))
    except Exception as e:
        logging.error("create_run_session failed at dispatch (run=%s): %s", run_id, e, exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Could not dispatch run: {type(e).__name__}: {e}",
        ) from e

    background_tasks.add_task(
        _run_orchestrator_bg,
        run_id,
        body.request,
        body.business_context,
        body.user_id,
    )
    return {"status": "running", "run_id": run_id}


@app.get("/agent/run/status/{run_id}", tags=["Agent"], dependencies=[Depends(verify_api_key)])
def agent_run_status(run_id: str):
    """Poll for the result of an async orchestrator run."""
    session = db.get_run_by_run_id(run_id)
    if not session:
        raise HTTPException(status_code=404, detail="Run not found.")

    if session.status == "running":
        return {"status": "running"}
    if session.status == "completed":
        return {"status": "completed", "result": session.output_data}
    # status == "failed" (or any other terminal state we set)
    err = None
    if isinstance(session.output_data, dict):
        err = session.output_data.get("error")
    return {"status": "failed", "error": err, "result": session.output_data}


@app.post("/agent/run/async", response_model=AgentQueuedResponse, status_code=202, tags=["Agent"],
          dependencies=[Depends(verify_api_key)])
def agent_run_async(body: AgentRunRequest):
    """
    Queue an orchestrator run in the background.
    """
    if not celery_app:
        raise HTTPException(
            status_code=501, detail="Celery not configured on this server.")

    task = run_orchestrator.delay(body.request, body.user_id)
    return AgentQueuedResponse(status="queued", task_id=task.id)


@app.get("/agent/run/{task_id}", response_model=AgentStatusResponse, tags=["Agent"],
         dependencies=[Depends(verify_api_key)])
def agent_run_celery_status(task_id: str):
    """
    Check the status of an asynchronous orchestrator run.
    """
    if not celery_app:
        raise HTTPException(
            status_code=501, detail="Celery not configured on this server.")

    task = run_orchestrator.AsyncResult(task_id)
    if task.state == 'PENDING':
        return {"status": "pending"}
    elif task.state != 'FAILURE':
        return {"status": task.state.lower(), "result": task.result}
    else:
        return {"status": "failed", "result": {"error": str(task.info)}}


@app.get("/profile/{user_id}", response_model=BusinessProfileModel, tags=["Profile"],
         dependencies=[Depends(verify_api_key)])
def get_profile(user_id: str):
    """Retrieve saved business profile for a user."""
    profile = db.get_profile(user_id)
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found.")
    return profile


@app.put("/profile/{user_id}", response_model=BusinessProfileModel, tags=["Profile"],
         dependencies=[Depends(verify_api_key)])
def upsert_profile(user_id: str, body: BusinessProfileModel):
    """Create or update the business profile for a user."""
    body.user_id = user_id
    try:
        return db.upsert_profile(body)
    except Exception as e:
        # Surface the underlying error to the frontend instead of letting it
        # bubble up as an opaque 5xx. Most common cause is a Supabase column
        # the deployed schema doesn't have yet (pending migration) — naming
        # the failure lets the user act on it.
        logging.error("PUT /profile/%s failed: %s", user_id, e, exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Profile save failed: {type(e).__name__}: {e}",
        ) from e


# -----------------------------
# Onboarding: URL scan + prefill
# -----------------------------
# Pilot-stage: concierge onboarding for the first 10 customers.
# Theo pre-seeds a small dict of tokens → profiles so a signed URL can
# open the onboarding flow with real customer data. No DB table yet.

_ONBOARD_PREFILL: Dict[str, Dict[str, Any]] = {
    # Example — replace with real tokens per pilot customer.
    # "cedar-ridge": {
    #     "url": "https://cedarridgeroofing.com",
    #     "company": "Cedar Ridge Roofing",
    #     "vertical": "roofing",
    #     "goals": ["respond", "book", "nurture"],
    #     "integrations": ["jobber", "gcal", "twilio"],
    # },
}


def _normalize_url(raw: str) -> tuple[str, str]:
    """Return (display_url, domain) for a user-supplied site URL."""
    s = (raw or "").strip()
    if not s:
        return ("", "")
    # Attach scheme so urlparse works on bare domains.
    if not s.lower().startswith(("http://", "https://")):
        s = "https://" + s
    try:
        from urllib.parse import urlparse
        parsed = urlparse(s)
        domain = (parsed.netloc or "").lower()
        if domain.startswith("www."):
            domain = domain[4:]
        return (s, domain)
    except Exception:
        return (s, s)


def _guess_vertical(types: Sequence[str]) -> Optional[str]:
    """Map Google Places `types` → a ProPlan vertical id."""
    t = {x.lower() for x in (types or [])}
    if t & {"roofing_contractor", "plumber", "electrician",
            "general_contractor", "hvac_contractor", "home_services"}:
        return "roofing"  # "home services" bucket
    if t & {"real_estate_agency", "real_estate_agent"}:
        return "realestate"
    if t & {"dentist", "doctor", "hospital", "physiotherapist",
            "optometrist", "health"}:
        return "healthcare"
    return None


def _pick_review(reviews: Sequence[Dict[str, Any]]) -> Optional[OnboardReview]:
    """Pick the most recent review with text — prefer 5-star, fall back
    to the most recent of any rating. Review becomes the proof moment
    shown after the scan completes."""
    if not reviews:
        return None
    with_text = [r for r in reviews if (r.get("text") or "").strip()]
    if not with_text:
        return None
    # Google returns `time` as a unix timestamp; sort desc so most recent first.
    with_text.sort(key=lambda r: r.get("time") or 0, reverse=True)
    five_stars = [r for r in with_text if (r.get("rating") or 0) >= 5]
    chosen = (five_stars or with_text)[0]
    return OnboardReview(
        author=str(chosen.get("author_name") or "A customer"),
        rating=int(chosen.get("rating") or 0),
        text=str(chosen.get("text") or "").strip(),
        when=chosen.get("relative_time_description"),
    )


def _fetch_site_title(url: str, client: "httpx.Client") -> Optional[str]:
    """Best-effort grab of the site <title> for a backup company name."""
    try:
        resp = client.get(url, timeout=4.0, follow_redirects=True,
                          headers={"User-Agent": "ProPlan-Onboarding/1.0"})
        if resp.status_code >= 400:
            return None
        import re
        m = re.search(r"<title[^>]*>(.*?)</title>", resp.text, re.IGNORECASE | re.DOTALL)
        if not m:
            return None
        # Strip site suffixes like "… | Home" or "… - Official Site".
        title = re.sub(r"\s+", " ", m.group(1)).strip()
        title = re.split(r"\s[|\-–·]\s", title)[0].strip()
        return title or None
    except Exception:
        return None


def _google_places_lookup(query: str, api_key: str,
                          client: "httpx.Client") -> Dict[str, Any]:
    """Run Text Search + Place Details against Google Places (classic API).
    Returns {} on any error so the scan degrades gracefully."""
    try:
        find = client.get(
            "https://maps.googleapis.com/maps/api/place/findplacefromtext/json",
            params={
                "input": query,
                "inputtype": "textquery",
                "fields": "place_id,name,formatted_address,types",
                "key": api_key,
            },
            timeout=5.0,
        )
        candidates = find.json().get("candidates") or []
        if not candidates:
            return {}
        place_id = candidates[0].get("place_id")
        if not place_id:
            return {}
        details = client.get(
            "https://maps.googleapis.com/maps/api/place/details/json",
            params={
                "place_id": place_id,
                "fields": ("name,formatted_address,types,reviews,"
                           "url,international_phone_number,website,"
                           "user_ratings_total"),
                "key": api_key,
            },
            timeout=5.0,
        )
        return details.json().get("result") or {}
    except Exception as e:
        logging.warning("Google Places lookup failed for %r: %s", query, e)
        return {}


@app.post("/onboard/scan", response_model=OnboardScanResponse, tags=["Onboarding"])
def onboard_scan(body: OnboardScanRequest):
    """Scan a business URL. Returns any fields we could recover from the
    site title + Google Places. Missing fields come back null and the
    onboarding UI lets the operator fill them inline."""
    display_url, domain = _normalize_url(body.url)
    if not domain:
        raise HTTPException(status_code=400, detail="Invalid URL.")

    if httpx is None:
        # httpx is a hard requirement for the scan; 501 mirrors the Slack path.
        raise HTTPException(
            status_code=501,
            detail="httpx is not installed on the server — scan unavailable.",
        )

    api_key = os.environ.get("GOOGLE_PLACES_API_KEY", "").strip()

    with httpx.Client() as client:
        site_title = _fetch_site_title(display_url, client)
        place: Dict[str, Any] = {}
        if api_key:
            # Query Places by the site title first (more specific), then
            # fall back to the bare domain.
            place = (_google_places_lookup(site_title, api_key, client)
                     if site_title else {})
            if not place:
                place = _google_places_lookup(domain, api_key, client)
        elif not site_title:
            logging.warning(
                "onboard_scan: GOOGLE_PLACES_API_KEY not set and site title "
                "unreadable — returning empty profile for %s", domain)

    company = place.get("name") or site_title
    location = place.get("formatted_address")
    vertical = _guess_vertical(place.get("types") or [])
    review = _pick_review(place.get("reviews") or [])

    return OnboardScanResponse(
        company=company,
        url=domain,
        owner=None,          # Not derivable from Places; left for manual edit.
        location=location,
        vertical=vertical,
        services=None,
        years_operating=None,
        review=review,
    )


@app.get("/onboard/prefill/{token}", response_model=OnboardPrefillResponse,
         tags=["Onboarding"])
def onboard_prefill(token: str):
    """Look up a pilot-customer pre-seed by token. 404 if unknown."""
    data = _ONBOARD_PREFILL.get(token)
    if data is None:
        raise HTTPException(status_code=404, detail="Unknown onboarding token.")
    return OnboardPrefillResponse(token=token, **data)


@app.get("/runs", tags=["History"], response_model=list[AgentSessionModel], dependencies=[Depends(verify_api_key)])
def list_runs(
    user_id: str = Query(..., description="User ID to filter runs"),
    limit: int = Query(20, ge=1, le=100),
):
    """List recent orchestrator runs for a user."""
    return db.get_runs(user_id, limit=limit)


@app.get("/leads", response_model=List[LeadModel], tags=["Leads"],
         dependencies=[Depends(verify_api_key)])
def list_leads(
    min_score: Optional[float] = Query(
        None, ge=0, le=100, description="Minimum lead score filter"),
    limit: Optional[int] = Query(
        None, ge=1, le=500, description="Max results to return"),
    offset: int = Query(0, ge=0, description="Number of results to skip"),
):
    """
    List leads, optionally filtered by minimum score and paginated.
    """
    return db.get_leads(min_score, limit=limit, offset=offset)


_LEAD_CSV_COLUMNS: Sequence[str] = (
    "full_name", "email", "phone", "company_name", "role", "inquiry_type",
    "icp_score", "qualification_status", "qualification_rationale",
    "source", "created_at", "id",
)

_CAMPAIGN_CSV_COLUMNS: Sequence[str] = (
    "name", "status", "id", "created_at", "updated_at",
)


def _csv_cell(value: Any) -> str:
    """Flatten a model field into a single CSV cell."""
    if value is None:
        return ""
    if isinstance(value, list):
        return "; ".join(str(v) for v in value)
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def _rows_to_csv(rows: List[Any], columns: Sequence[str]) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf, quoting=csv.QUOTE_MINIMAL, lineterminator="\r\n")
    writer.writerow(columns)
    for row in rows:
        data = row.model_dump() if hasattr(row, "model_dump") else dict(row)
        writer.writerow([_csv_cell(data.get(col)) for col in columns])
    return buf.getvalue()


def _csv_response(body: str, filename_stem: str) -> Response:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    filename = f"{filename_stem}-{stamp}.csv"
    return Response(
        content=body,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/leads/export.csv", tags=["Leads"],
         dependencies=[Depends(verify_api_key)])
def export_leads_csv(
    min_score: Optional[float] = Query(None, ge=0, le=100),
    limit: Optional[int] = Query(None, ge=1, le=5000),
    offset: int = Query(0, ge=0),
):
    """Download leads as CSV, honoring the same filters as GET /leads."""
    rows = db.get_leads(min_score, limit=limit, offset=offset)
    return _csv_response(_rows_to_csv(rows, _LEAD_CSV_COLUMNS), "proplan-leads")


# -----------------------------
# Integrations: Slack
# -----------------------------

def _require_slack_webhook(user_id: str) -> str:
    """Load the webhook URL for a user, 400/404 with a clear message if missing."""
    profile = db.get_profile(user_id)
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found. Save your profile first.")
    url = (profile.slack_webhook_url or "").strip()
    if not url:
        raise HTTPException(
            status_code=400,
            detail="Slack webhook not configured. Paste your incoming-webhook URL in PROFILE → INTEGRATIONS.",
        )
    # Guardrail against obvious misconfig — Slack webhooks always live here.
    if not url.startswith("https://hooks.slack.com/"):
        raise HTTPException(
            status_code=400,
            detail="That URL does not look like a Slack incoming webhook (should start with https://hooks.slack.com/).",
        )
    return url


def _post_to_slack(webhook_url: str, text: str) -> None:
    """POST a plaintext message to a Slack incoming webhook. Raises HTTPException on non-2xx."""
    if httpx is None:
        raise HTTPException(
            status_code=501,
            detail="Slack integration unavailable: httpx is not installed on the server.",
        )
    try:
        resp = httpx.post(webhook_url, json={"text": text}, timeout=10.0)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Could not reach Slack: {e}") from e
    if resp.status_code >= 300:
        # Slack returns a short diagnostic string on error (e.g. "invalid_token", "no_service").
        raise HTTPException(
            status_code=502,
            detail=f"Slack rejected the message (HTTP {resp.status_code}): {resp.text[:200]}",
        )


def _format_lead_digest(rows: List[LeadModel], min_score: Optional[float]) -> str:
    if not rows:
        header = "*ProPlan — No leads to send*"
        if min_score is not None and min_score > 0:
            header += f" (score ≥ {int(min_score)})"
        return header
    header = f"*ProPlan — Top {len(rows)} leads*"
    if min_score is not None and min_score > 0:
        header += f" (score ≥ {int(min_score)})"
    lines = [header]
    for i, lead in enumerate(rows, start=1):
        score = f"{lead.icp_score:.0f}" if lead.icp_score is not None else "—"
        company = lead.company_name or "Unknown"
        role = f" · {lead.role}" if lead.role else ""
        lines.append(f"{i}. {lead.full_name} — {company}{role} — Score {score}")
    return "\n".join(lines)


@app.post("/integrations/slack/{user_id}/test", tags=["Integrations"],
          dependencies=[Depends(verify_api_key)])
def slack_test(user_id: str):
    """Send a short ping to the configured Slack webhook — use this to verify setup."""
    url = _require_slack_webhook(user_id)
    _post_to_slack(url, ":satellite_antenna: ProPlan connection test — if you see this, your Slack integration is working.")
    return {"status": "sent"}


@app.post("/integrations/slack/{user_id}/leads", tags=["Integrations"],
          dependencies=[Depends(verify_api_key)])
def slack_send_leads(
    user_id: str,
    min_score: Optional[float] = Query(None, ge=0, le=100),
    limit: int = Query(10, ge=1, le=50, description="Max leads to include in the digest"),
):
    """Post a formatted top-N lead digest to the user's Slack webhook."""
    url = _require_slack_webhook(user_id)
    rows = db.get_leads(min_score, limit=limit, offset=0)
    # Sort descending by score so the highest-fit leads are first in the digest.
    rows.sort(key=lambda l: l.icp_score or 0, reverse=True)
    _post_to_slack(url, _format_lead_digest(rows, min_score))
    return {"status": "sent", "count": len(rows)}


@app.get("/campaigns/export.csv", tags=["Campaigns"],
         dependencies=[Depends(verify_api_key)])
def export_campaigns_csv(
    limit: Optional[int] = Query(None, ge=1, le=5000),
    offset: int = Query(0, ge=0),
):
    """Download campaigns as CSV."""
    rows = db.get_campaigns(limit=limit, offset=offset)
    return _csv_response(_rows_to_csv(rows, _CAMPAIGN_CSV_COLUMNS), "proplan-campaigns")


@app.post("/campaigns", response_model=CampaignModel, status_code=201, tags=["Campaigns"],
          dependencies=[Depends(verify_api_key)])
def create_campaign(body: CampaignCreateRequest):
    """
    Create a new campaign.
    """
    campaign = CampaignModel(
        id=str(uuid.uuid4()),
        name=body.name,
        status=body.status,
    )
    return db.create_campaign(campaign)


@app.get("/campaigns", response_model=List[CampaignModel], tags=["Campaigns"],
         dependencies=[Depends(verify_api_key)])
def list_campaigns(
    limit: Optional[int] = Query(
        None, ge=1, le=500, description="Max results to return"),
    offset: int = Query(0, ge=0, description="Number of results to skip"),
):
    """
    List all campaigns, with optional pagination.
    """
    return db.get_campaigns(limit=limit, offset=offset)


# -----------------------------
# Run directly
# -----------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("api:app", host="0.0.0.0", port=8000, reload=True)
