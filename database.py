"""
Database abstraction layer for ProPlan Agent OS.

Supports an in-memory fallback for local development and a fully-featured
Supabase client for production persistence.
"""

import os
import threading
from typing import List, Dict, Any, Optional, Protocol
from pydantic import BaseModel, Field
import uuid
import time
import logging

# Re-use models from API layer (we'll move them here for cleaner imports, or just import them)
# But to avoid circular dependencies, let's define the core domain models here.


class LeadModel(BaseModel):
    """Lead data model."""
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    score: int = Field(ge=0, le=100)
    source: str = "manual"


class CampaignModel(BaseModel):
    """Campaign data model."""
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    status: str
    created_at: float = Field(default_factory=time.time)


class RunLogModel(BaseModel):
    """Execution memory log for a run."""
    run_id: str
    action: str
    timestamp: float = Field(default_factory=time.time)
    metadata: Dict[str, Any] = Field(default_factory=dict)


class DatabaseProvider(Protocol):
    """Protocol for ProPlan storage."""

    def get_leads(self, min_score: Optional[int] = None, limit: Optional[int]
                  = None, offset: int = 0) -> List[LeadModel]: ...

    def create_lead(self, lead: LeadModel) -> LeadModel: ...
    def get_campaigns(
        self, limit: Optional[int] = None, offset: int = 0) -> List[CampaignModel]: ...

    def create_campaign(self, campaign: CampaignModel) -> CampaignModel: ...
    def log_run(self, log: RunLogModel) -> None: ...


class InMemoryDatabase:
    """In-memory fallback for development and testing."""

    def __init__(self):
        self._lock = threading.Lock()
        self.leads: Dict[str, LeadModel] = {}
        self.campaigns: Dict[str, CampaignModel] = {}
        self.logs: List[RunLogModel] = []
        logging.info("Initialized InMemoryDatabase")

    def get_leads(self, min_score: Optional[int] = None, limit: Optional[int] = None, offset: int = 0) -> List[LeadModel]:
        with self._lock:
            results = list(self.leads.values())
        if min_score is not None:
            results = [lead for lead in results if lead.score >= min_score]
        results = results[offset:]
        if limit is not None:
            results = results[:limit]
        return results

    def create_lead(self, lead: LeadModel) -> LeadModel:
        with self._lock:
            self.leads[lead.id] = lead
        return lead

    def get_campaigns(self, limit: Optional[int] = None, offset: int = 0) -> List[CampaignModel]:
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

    def log_run(self, log: RunLogModel) -> None:
        with self._lock:
            self.logs.append(log)


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

    def get_leads(self, min_score: Optional[int] = None, limit: Optional[int] = None, offset: int = 0) -> List[LeadModel]:
        try:
            query = self.client.table("leads").select("*")
            if min_score is not None:
                query = query.gte("score", min_score)
            query = query.range(offset, offset + (limit or 1000) - 1)
            result = query.execute()
            return [LeadModel(**row) for row in result.data]
        except Exception as e:
            logging.error("SupabaseDatabase.get_leads failed: %s",
                          e, exc_info=True)
            raise

    def create_lead(self, lead: LeadModel) -> LeadModel:
        try:
            data = lead.model_dump()
            self.client.table("leads").insert(data).execute()
            return lead
        except Exception as e:
            logging.error(
                "SupabaseDatabase.create_lead failed: %s", e, exc_info=True)
            raise

    def get_campaigns(self, limit: Optional[int] = None, offset: int = 0) -> List[CampaignModel]:
        try:
            query = self.client.table("campaigns").select("*")
            query = query.range(offset, offset + (limit or 1000) - 1)
            result = query.execute()
            return [CampaignModel(**row) for row in result.data]
        except Exception as e:
            logging.error(
                "SupabaseDatabase.get_campaigns failed: %s", e, exc_info=True)
            raise

    def create_campaign(self, campaign: CampaignModel) -> CampaignModel:
        try:
            data = campaign.model_dump()
            self.client.table("campaigns").insert(data).execute()
            return campaign
        except Exception as e:
            logging.error(
                "SupabaseDatabase.create_campaign failed: %s", e, exc_info=True)
            raise

    def log_run(self, log: RunLogModel) -> None:
        try:
            data = log.model_dump()
            self.client.table("logs").insert(data).execute()
        except Exception as e:
            logging.error("SupabaseDatabase.log_run failed: %s",
                          e, exc_info=True)
            raise


def get_database() -> DatabaseProvider:
    """Factory to return the appropriate database connection based on env vars."""
    supabase_url = os.environ.get("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_KEY")

    if supabase_url and supabase_key:
        return SupabaseDatabase(supabase_url, supabase_key)
    else:
        logging.warning(
            "No SUPABASE_URL/KEY found. Falling back to InMemoryDatabase.")
        return InMemoryDatabase()


def extract_leads_from_memory(memory: List[Dict[str, Any]]) -> List[LeadModel]:
    """
    Parse execution memory entries and extract any discovered leads.

    This shared utility is used by both the sync API handler and the Celery worker
    to avoid duplicating the lead-extraction heuristic.
    """
    leads: List[LeadModel] = []
    for entry in memory:
        data = entry.get("result", {}).get("data")
        if isinstance(data, list):
            for item in data:
                if isinstance(item, dict) and "name" in item and "score" in item:
                    leads.append(LeadModel(
                        name=item["name"],
                        score=item["score"],
                        source="agent"
                    ))
    return leads
