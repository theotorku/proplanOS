"""
Database abstraction layer for ProPlan Agent OS.

Models and queries match the ProplanOS Supabase schema:
  - leads (full_name, email, company_name, icp_score, qualification_status, ...)
  - campaigns (name, status)
  - agent_sessions (agent_type, status, cost_usd, duration_ms, ...)
"""

import os
import threading
from typing import List, Dict, Any, Optional, Protocol
from pydantic import BaseModel, Field
import uuid
import time
from datetime import datetime, timezone
import logging


# ============================================================
# DOMAIN MODELS — match Supabase schema
# ============================================================

class LeadModel(BaseModel):
    """Lead record matching the Supabase leads table."""
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    full_name: str
    email: Optional[str] = None
    phone: Optional[str] = None
    company_name: Optional[str] = None
    role: Optional[str] = None
    inquiry_type: Optional[str] = None
    message: Optional[str] = None
    employee_count: Optional[int] = None
    monthly_lead_volume: Optional[int] = None
    project_types: Optional[List[str]] = None
    avg_project_budget: Optional[str] = None
    current_location: Optional[str] = None
    icp_score: Optional[float] = Field(default=None, ge=0, le=100)
    qualification_status: str = "pending"
    qualification_rationale: Optional[str] = None
    qualification_factors: Optional[Dict[str, Any]] = None
    source: str = "agent"
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class CampaignModel(BaseModel):
    """Campaign record matching the Supabase campaigns table."""
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    status: str = "draft"
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class AgentSessionModel(BaseModel):
    """Agent session record matching the Supabase agent_sessions table."""
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    lead_id: Optional[str] = None
    agent_type: str
    status: str = "running"
    input_data: Optional[Dict[str, Any]] = None
    output_data: Optional[Dict[str, Any]] = None
    reasoning_trace: Optional[str] = None
    cost_usd: Optional[float] = None
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None
    model_used: Optional[str] = None
    duration_ms: Optional[int] = None
    steps_taken: Optional[int] = None
    started_at: Optional[str] = None
    completed_at: Optional[str] = None


# ============================================================
# DATABASE PROTOCOL
# ============================================================

class DatabaseProvider(Protocol):
    """Protocol for ProPlan storage."""

    # Leads
    def get_leads(self, min_score: Optional[float] = None,
                  limit: Optional[int] = None, offset: int = 0) -> List[LeadModel]: ...
    def create_lead(self, lead: LeadModel) -> LeadModel: ...

    # Campaigns
    def get_campaigns(self, limit: Optional[int] = None,
                      offset: int = 0) -> List[CampaignModel]: ...
    def create_campaign(self, campaign: CampaignModel) -> CampaignModel: ...

    # Agent Sessions (run logging)
    def log_run(self, session: AgentSessionModel) -> None: ...


# ============================================================
# IN-MEMORY DATABASE (Development / Testing)
# ============================================================

class InMemoryDatabase:
    """In-memory fallback for development and testing."""

    def __init__(self):
        self._lock = threading.Lock()
        self.leads: Dict[str, LeadModel] = {}
        self.campaigns: Dict[str, CampaignModel] = {}
        self.sessions: List[AgentSessionModel] = []
        logging.info("Initialized InMemoryDatabase")

    def get_leads(self, min_score: Optional[float] = None,
                  limit: Optional[int] = None, offset: int = 0) -> List[LeadModel]:
        with self._lock:
            results = list(self.leads.values())
        if min_score is not None:
            results = [l for l in results if (l.icp_score or 0) >= min_score]
        results = results[offset:]
        if limit is not None:
            results = results[:limit]
        return results

    def create_lead(self, lead: LeadModel) -> LeadModel:
        with self._lock:
            self.leads[lead.id] = lead
        return lead

    def get_campaigns(self, limit: Optional[int] = None,
                      offset: int = 0) -> List[CampaignModel]:
        with self._lock:
            results = list(self.campaigns.values())
        results = results[offset:]
        if limit is not None:
            results = results[:limit]
        return results

    def create_campaign(self, campaign: CampaignModel) -> CampaignModel:
        with self._lock:
            self.campaigns[campaign.id] = campaign
        return campaign

    def log_run(self, session: AgentSessionModel) -> None:
        with self._lock:
            self.sessions.append(session)


# ============================================================
# SUPABASE DATABASE (Production)
# ============================================================

class SupabaseDatabase:
    """Production database connected to Supabase."""

    def __init__(self, url: str, key: str):
        try:
            from supabase import create_client, Client
            self.client: Client = create_client(url, key)
            logging.info("Initialized SupabaseDatabase")
        except ImportError:
            raise ImportError(
                "Please install the 'supabase' package to use SupabaseDatabase.")

    def get_leads(self, min_score: Optional[float] = None,
                  limit: Optional[int] = None, offset: int = 0) -> List[LeadModel]:
        try:
            query = self.client.table("leads").select("*")
            if min_score is not None:
                query = query.gte("icp_score", min_score)
            query = query.order("created_at", desc=True)
            query = query.range(offset, offset + (limit or 1000) - 1)
            result = query.execute()
            return [LeadModel(**row) for row in result.data]
        except Exception as e:
            logging.error("SupabaseDatabase.get_leads failed: %s",
                          e, exc_info=True)
            raise

    def create_lead(self, lead: LeadModel) -> LeadModel:
        try:
            data = lead.model_dump(exclude_none=True)
            self.client.table("leads").insert(data).execute()
            return lead
        except Exception as e:
            logging.error(
                "SupabaseDatabase.create_lead failed: %s", e, exc_info=True)
            raise

    def get_campaigns(self, limit: Optional[int] = None,
                      offset: int = 0) -> List[CampaignModel]:
        try:
            query = self.client.table("campaigns").select("*")
            query = query.order("created_at", desc=True)
            query = query.range(offset, offset + (limit or 1000) - 1)
            result = query.execute()
            return [CampaignModel(**row) for row in result.data]
        except Exception as e:
            logging.error(
                "SupabaseDatabase.get_campaigns failed: %s", e, exc_info=True)
            raise

    def create_campaign(self, campaign: CampaignModel) -> CampaignModel:
        try:
            data = campaign.model_dump(exclude_none=True)
            self.client.table("campaigns").insert(data).execute()
            return campaign
        except Exception as e:
            logging.error(
                "SupabaseDatabase.create_campaign failed: %s", e, exc_info=True)
            raise

    def log_run(self, session: AgentSessionModel) -> None:
        try:
            data = session.model_dump(exclude_none=True)
            self.client.table("agent_sessions").insert(data).execute()
        except Exception as e:
            logging.error("SupabaseDatabase.log_run failed: %s",
                          e, exc_info=True)
            raise


# ============================================================
# FACTORY
# ============================================================

def get_database() -> DatabaseProvider:
    """Factory to return the appropriate database based on env vars."""
    supabase_url = os.environ.get("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_KEY")

    if supabase_url and supabase_key:
        return SupabaseDatabase(supabase_url, supabase_key)
    else:
        logging.warning(
            "No SUPABASE_URL/KEY found. Falling back to InMemoryDatabase.")
        return InMemoryDatabase()


# ============================================================
# UTILITIES
# ============================================================

def extract_leads_from_memory(memory: List[Dict[str, Any]]) -> List[LeadModel]:
    """
    Parse execution memory entries and extract any discovered leads.

    Maps the orchestrator's tool output (name, score) to the Supabase
    schema (full_name, icp_score).
    """
    leads: List[LeadModel] = []
    for entry in memory:
        data = entry.get("result", {}).get("data")
        if isinstance(data, list):
            for item in data:
                if isinstance(item, dict) and "name" in item and "score" in item:
                    leads.append(LeadModel(
                        full_name=item["name"],
                        icp_score=float(item["score"]),
                        qualification_status="pending",
                        source="agent"
                    ))
    return leads
