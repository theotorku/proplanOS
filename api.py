"""
ProPlan Agent API — FastAPI layer for the orchestrator.

Endpoints:
    POST /agent/run      — Run the orchestrator with a user request
    GET  /leads          — List leads (with optional min_score filter)
    POST /campaigns      — Create a new campaign
    GET  /campaigns      — List all campaigns
    GET  /health         — Health check
"""

from fastapi import FastAPI, HTTPException, Query, Depends, Security
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security.api_key import APIKeyHeader
from pydantic import BaseModel, Field
from typing import Any, Dict, List, Optional
import uuid
import time
import os
import logging

from proplanOrchestrator import (
    Orchestrator, Tool, SalesAgent, MarketingAgent, SupportAgent, OpsAgent,
    SecurityPolicy, find_leads_tool, generate_copy_tool, search_knowledge_base,
    schedule_task, run_workflow,
    FindLeadsSchema, GenerateCopySchema, SearchKnowledgeBaseSchema,
    ScheduleTaskSchema, RunWorkflowSchema
)
from database import get_database, LeadModel, CampaignModel, AgentSessionModel, extract_leads_from_memory
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


class AgentRunResponse(BaseModel):
    """Response body for POST /agent/run."""
    status: str
    run_id: str
    user_id: str
    total_cost: float
    cost_breakdown: Dict[str, float]
    memory: List[Dict[str, Any]]


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
    """Health check endpoint."""
    return {"status": "healthy", "timestamp": time.time()}


@app.post("/agent/run", response_model=AgentRunResponse, tags=["Agent"],
          dependencies=[Depends(verify_api_key)])
def agent_run(body: AgentRunRequest):
    """
    Run the orchestrator with a natural-language request.

    The orchestrator will plan, dispatch tasks to agents, and evaluate results.
    Returns cost tracking, execution memory, and run status.
    """
    orchestrator = create_orchestrator()
    result = orchestrator.run(body.request)

    # Persist any leads discovered during execution (shared utility — no duplication)
    for lead in extract_leads_from_memory(result.get("memory", [])):
        db.create_lead(lead)

    db.log_run(AgentSessionModel(
        agent_type="orchestrator",
        status="completed",
        input_data={"user_id": body.user_id, "request": body.request},
        output_data={
            "status": result["status"],
            "total_cost": result["total_cost"],
            "run_id": result["run_id"]
        },
        cost_usd=result["total_cost"],
    ))

    return AgentRunResponse(
        status=result["status"],
        run_id=result["run_id"],
        user_id=body.user_id,
        total_cost=result["total_cost"],
        cost_breakdown=result["cost_breakdown"],
        memory=result["memory"]
    )


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
def agent_run_status(task_id: str):
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


@app.get("/leads", response_model=List[LeadModel], tags=["Leads"],
         dependencies=[Depends(verify_api_key)])
def list_leads(
    min_score: Optional[int] = Query(
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
