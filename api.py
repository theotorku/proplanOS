"""
ProPlan Agent API — FastAPI layer for the orchestrator.

Endpoints:
    POST /agent/run      — Run the orchestrator with a user request
    GET  /leads          — List leads (with optional min_score filter)
    POST /campaigns      — Create a new campaign
    GET  /campaigns      — List all campaigns
    GET  /health         — Health check
"""

from fastapi import FastAPI, HTTPException, Query, Depends, Security, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security.api_key import APIKeyHeader
from pydantic import BaseModel, Field
from typing import Any, Dict, List, Optional
import uuid
import time
import os
import logging
import threading

from proplanOrchestrator import (
    Orchestrator, Tool, SalesAgent, MarketingAgent, SupportAgent, OpsAgent,
    SecurityPolicy, find_leads_tool, generate_copy_tool, search_knowledge_base,
    schedule_task, run_workflow,
    FindLeadsSchema, GenerateCopySchema, SearchKnowledgeBaseSchema,
    ScheduleTaskSchema, RunWorkflowSchema
)
from database import get_database, LeadModel, CampaignModel, AgentSessionModel, BusinessProfileModel, extract_leads_from_memory
from llm import AnthropicPlannerProvider, AnthropicAgentProvider

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


# -----------------------------
# Database Connection
# -----------------------------

db = get_database()

# -----------------------------
# Async Run Store
# -----------------------------
# In-memory store for background run state (works for single-worker deployments).
# Key: run_id → {status, result?, error?, _ts}
_run_store: Dict[str, Dict[str, Any]] = {}
_run_store_lock = threading.Lock()
_RUN_TTL_SECONDS = 3600  # evict entries older than 1 hour


def _evict_stale_runs() -> None:
    """Remove finished run_store entries older than _RUN_TTL_SECONDS. Call under _run_store_lock."""
    cutoff = time.time() - _RUN_TTL_SECONDS
    stale = [
        k for k, v in _run_store.items()
        if v.get("status") != "running" and v.get("_ts", 0) < cutoff
    ]
    for k in stale:
        del _run_store[k]


def _db_backend_name() -> str:
    """Return "supabase" or "memory" so callers can see which store is live."""
    return "supabase" if type(db).__name__ == "SupabaseDatabase" else "memory"


def _run_orchestrator_bg(run_id: str, request: str, business_context: Optional[str], user_id: str) -> None:
    """Background task: run orchestrator and write result to _run_store."""
    started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    persistence_errors: List[Dict[str, Any]] = []
    leads_extracted = 0
    leads_saved = 0
    session_logged = False

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
        try:
            # NOTE: run_id is intentionally NOT set as a top-level column because
            # the deployed Supabase agent_sessions table predates that column
            # (PGRST204). It still travels in output_data so runs remain
            # correlatable. Drop this workaround once
            # migrations/0001_add_run_id_to_agent_sessions.sql is applied.
            db.log_run(AgentSessionModel(
                user_id=user_id,
                agent_type="orchestrator",
                status=session_status,
                input_data={"user_id": user_id, "request": request, "run_id": run_id},
                output_data={"status": result["status"], "total_cost": result["total_cost"], "run_id": result["run_id"]},
                cost_usd=result["total_cost"],
                started_at=started_at,
                completed_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            ))
            session_logged = True
        except Exception as e:
            logging.error(
                "Session logging failed (run=%s backend=%s): %s",
                run_id, _db_backend_name(), e, exc_info=True,
            )
            persistence_errors.append({
                "target": "session",
                "error_type": type(e).__name__,
                "message": str(e),
            })

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
                "session_logged": session_logged,
                "errors": persistence_errors,
            },
        }
        with _run_store_lock:
            _run_store[run_id] = {"status": "completed", "result": final, "_ts": time.time()}

    except Exception as e:
        logging.error("Background run %s failed: %s", run_id, e, exc_info=True)
        with _run_store_lock:
            _run_store[run_id] = {"status": "failed", "error": str(e), "_ts": time.time()}


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
_raw_origins = os.environ.get("ALLOWED_ORIGINS", "http://localhost:5173")
_allowed_origins = [o.strip() for o in _raw_origins.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


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
    with _run_store_lock:
        _evict_stale_runs()
        _run_store[run_id] = {"status": "running", "_ts": time.time()}

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
    with _run_store_lock:
        _evict_stale_runs()
        run = _run_store.get(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found. It may have expired or the server restarted.")
    return run


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
    return db.upsert_profile(body)


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
