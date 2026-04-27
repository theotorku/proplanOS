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
    source_conversation_id: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class CampaignModel(BaseModel):
    """Campaign record matching the Supabase campaigns table."""
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    status: str = "draft"
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class BusinessProfileModel(BaseModel):
    """Business profile for context injection into every agent run."""
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    user_id: str
    company_name: Optional[str] = None
    what_we_do: Optional[str] = None
    icp: Optional[str] = None
    target_industries: Optional[str] = None
    company_size: Optional[str] = None
    geography: Optional[str] = None
    lead_signals: Optional[str] = None
    value_proposition: Optional[str] = None
    tone: str = "professional"
    # Per-user Slack incoming-webhook URL. Stored in plaintext alongside the
    # rest of the profile for v1; access is gated by the same API key as
    # the profile endpoints.
    slack_webhook_url: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class ChatConversationModel(BaseModel):
    """One visitor session on the embeddable site chat or /chat page."""
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    user_id: Optional[str] = None
    status: str = "active"           # active | ended | escalated
    origin: Optional[str] = None     # browser Origin header
    ip: Optional[str] = None
    user_agent: Optional[str] = None
    referrer: Optional[str] = None
    utm: Optional[Dict[str, Any]] = None
    message_count: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    escalated_to_slack: bool = False
    lead_captured: bool = False
    started_at: Optional[str] = None
    last_message_at: Optional[str] = None
    ended_at: Optional[str] = None


class ChatMessageModel(BaseModel):
    """One turn inside a chat conversation."""
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    conversation_id: str
    role: str                        # user | assistant | system | tool
    content: str
    tool_name: Optional[str] = None
    tool_payload: Optional[Dict[str, Any]] = None
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None
    cost_usd: Optional[float] = None
    created_at: Optional[str] = None


class AgentSessionModel(BaseModel):
    """Agent session record matching the Supabase agent_sessions table."""
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    run_id: Optional[str] = None
    user_id: Optional[str] = None
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
    def create_run_session(self, session: AgentSessionModel) -> AgentSessionModel: ...
    def update_run_session(self, run_id: str, **fields: Any) -> None: ...
    def get_run_by_run_id(self, run_id: str) -> Optional[AgentSessionModel]: ...
    def get_runs(self, user_id: str, limit: int = 20) -> List[AgentSessionModel]: ...

    # Business Profiles
    def get_profile(self, user_id: str) -> Optional["BusinessProfileModel"]: ...
    def upsert_profile(self, profile: "BusinessProfileModel") -> "BusinessProfileModel": ...

    # Chat
    def create_chat_conversation(self, convo: ChatConversationModel) -> ChatConversationModel: ...
    def get_chat_conversation(self, convo_id: str) -> Optional[ChatConversationModel]: ...
    def update_chat_conversation(self, convo_id: str, **fields: Any) -> None: ...
    def create_chat_message(self, msg: ChatMessageModel) -> ChatMessageModel: ...
    def get_chat_messages(self, convo_id: str) -> List[ChatMessageModel]: ...
    def count_recent_conversations_by_ip(self, ip: str, since_iso: str) -> int: ...


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
        self.profiles: Dict[str, "BusinessProfileModel"] = {}
        self.chat_conversations: Dict[str, ChatConversationModel] = {}
        self.chat_messages: List[ChatMessageModel] = []
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
        # Match SupabaseDatabase upsert behavior: a lead with the same
        # email replaces the existing row instead of producing a duplicate.
        with self._lock:
            if lead.email:
                for existing_id, existing in self.leads.items():
                    if existing.email and existing.email == lead.email:
                        lead.id = existing_id
                        break
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

    def create_run_session(self, session: AgentSessionModel) -> AgentSessionModel:
        with self._lock:
            self.sessions.append(session)
        return session

    def update_run_session(self, run_id: str, **fields: Any) -> None:
        with self._lock:
            for s in self.sessions:
                if s.run_id == run_id:
                    for k, v in fields.items():
                        setattr(s, k, v)
                    return

    def get_run_by_run_id(self, run_id: str) -> Optional[AgentSessionModel]:
        with self._lock:
            for s in self.sessions:
                if s.run_id == run_id:
                    return s
        return None

    def get_profile(self, user_id: str) -> Optional["BusinessProfileModel"]:
        return self.profiles.get(user_id)

    def upsert_profile(self, profile: "BusinessProfileModel") -> "BusinessProfileModel":
        profile.updated_at = datetime.now(timezone.utc).isoformat()
        with self._lock:
            self.profiles[profile.user_id] = profile
        return profile

    def get_runs(self, user_id: str, limit: int = 20) -> List[AgentSessionModel]:
        with self._lock:
            runs = [s for s in self.sessions if s.user_id == user_id and s.agent_type == "orchestrator"]
        return list(reversed(runs))[:limit]

    # ---- Chat ----
    def create_chat_conversation(self, convo: ChatConversationModel) -> ChatConversationModel:
        with self._lock:
            self.chat_conversations[convo.id] = convo
        return convo

    def get_chat_conversation(self, convo_id: str) -> Optional[ChatConversationModel]:
        return self.chat_conversations.get(convo_id)

    def update_chat_conversation(self, convo_id: str, **fields: Any) -> None:
        with self._lock:
            convo = self.chat_conversations.get(convo_id)
            if not convo:
                return
            for k, v in fields.items():
                setattr(convo, k, v)

    def create_chat_message(self, msg: ChatMessageModel) -> ChatMessageModel:
        with self._lock:
            self.chat_messages.append(msg)
        return msg

    def get_chat_messages(self, convo_id: str) -> List[ChatMessageModel]:
        with self._lock:
            return [m for m in self.chat_messages if m.conversation_id == convo_id]

    def count_recent_conversations_by_ip(self, ip: str, since_iso: str) -> int:
        with self._lock:
            return sum(
                1 for c in self.chat_conversations.values()
                if c.ip == ip and (c.started_at or "") >= since_iso
            )


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
            # Upsert on email so re-discovering the same lead refreshes the
            # row (e.g. updated score/role) instead of duplicating it. Leads
            # without an email fall back to plain insert because the partial
            # unique index in 0003 only covers email-bearing rows.
            if data.get("email"):
                self.client.table("leads").upsert(data, on_conflict="email").execute()
            else:
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
            logging.error("SupabaseDatabase.log_run failed: %s", e, exc_info=True)
            raise

    def create_run_session(self, session: AgentSessionModel) -> AgentSessionModel:
        try:
            data = session.model_dump(exclude_none=True)
            self.client.table("agent_sessions").insert(data).execute()
            return session
        except Exception as e:
            logging.error("SupabaseDatabase.create_run_session failed: %s", e, exc_info=True)
            raise

    def update_run_session(self, run_id: str, **fields: Any) -> None:
        try:
            self.client.table("agent_sessions").update(fields).eq("run_id", run_id).execute()
        except Exception as e:
            logging.error("SupabaseDatabase.update_run_session failed: %s", e, exc_info=True)
            raise

    def get_run_by_run_id(self, run_id: str) -> Optional[AgentSessionModel]:
        try:
            result = (
                self.client.table("agent_sessions")
                .select("*")
                .eq("run_id", run_id)
                .limit(1)
                .execute()
            )
            return AgentSessionModel(**result.data[0]) if result.data else None
        except Exception as e:
            logging.warning("SupabaseDatabase.get_run_by_run_id failed: %s", e)
            return None

    def get_profile(self, user_id: str) -> Optional["BusinessProfileModel"]:
        try:
            result = self.client.table("business_profiles").select("*").eq("user_id", user_id).limit(1).execute()
            return BusinessProfileModel(**result.data[0]) if result.data else None
        except Exception as e:
            logging.warning("SupabaseDatabase.get_profile failed: %s", e)
            return None

    def upsert_profile(self, profile: "BusinessProfileModel") -> "BusinessProfileModel":
        try:
            # Coerce empty strings to None so "clear this field" actually
            # writes NULL — the previous strip-empties filter silently
            # retained old values, which made slack_webhook_url (and any
            # other nullable string) impossible to clear once saved.
            raw = profile.model_dump()
            data = {k: (None if isinstance(v, str) and v == "" else v) for k, v in raw.items()}
            # Don't send created_at=None on first insert — the column is NOT NULL
            # with a default. Letting the DB default populate it preserves the
            # original value on subsequent upserts (Postgres only overwrites
            # columns we send).
            if data.get("created_at") is None:
                data.pop("created_at", None)
            data["updated_at"] = datetime.now(timezone.utc).isoformat()
            self.client.table("business_profiles").upsert(data, on_conflict="user_id").execute()
            return profile
        except Exception as e:
            logging.error("SupabaseDatabase.upsert_profile failed: %s", e, exc_info=True)
            raise

    def get_runs(self, user_id: str, limit: int = 20) -> List[AgentSessionModel]:
        try:
            result = (
                self.client.table("agent_sessions")
                .select("*")
                .eq("user_id", user_id)
                .eq("agent_type", "orchestrator")
                .order("started_at", desc=True)
                .limit(limit)
                .execute()
            )
            return [AgentSessionModel(**row) for row in result.data]
        except Exception as e:
            logging.warning("SupabaseDatabase.get_runs failed: %s", e)
            return []

    # ---- Chat ----
    def create_chat_conversation(self, convo: ChatConversationModel) -> ChatConversationModel:
        try:
            data = convo.model_dump(exclude_none=True)
            self.client.table("chat_conversations").insert(data).execute()
            return convo
        except Exception as e:
            logging.error("SupabaseDatabase.create_chat_conversation failed: %s", e, exc_info=True)
            raise

    def get_chat_conversation(self, convo_id: str) -> Optional[ChatConversationModel]:
        try:
            result = (
                self.client.table("chat_conversations")
                .select("*")
                .eq("id", convo_id)
                .limit(1)
                .execute()
            )
            return ChatConversationModel(**result.data[0]) if result.data else None
        except Exception as e:
            logging.warning("SupabaseDatabase.get_chat_conversation failed: %s", e)
            return None

    def update_chat_conversation(self, convo_id: str, **fields: Any) -> None:
        try:
            self.client.table("chat_conversations").update(fields).eq("id", convo_id).execute()
        except Exception as e:
            logging.error("SupabaseDatabase.update_chat_conversation failed: %s", e, exc_info=True)
            raise

    def create_chat_message(self, msg: ChatMessageModel) -> ChatMessageModel:
        try:
            data = msg.model_dump(exclude_none=True)
            self.client.table("chat_messages").insert(data).execute()
            return msg
        except Exception as e:
            logging.error("SupabaseDatabase.create_chat_message failed: %s", e, exc_info=True)
            raise

    def get_chat_messages(self, convo_id: str) -> List[ChatMessageModel]:
        try:
            result = (
                self.client.table("chat_messages")
                .select("*")
                .eq("conversation_id", convo_id)
                .order("created_at", desc=False)
                .execute()
            )
            return [ChatMessageModel(**row) for row in result.data]
        except Exception as e:
            logging.warning("SupabaseDatabase.get_chat_messages failed: %s", e)
            return []

    def count_recent_conversations_by_ip(self, ip: str, since_iso: str) -> int:
        try:
            result = (
                self.client.table("chat_conversations")
                .select("id", count="exact")
                .eq("ip", ip)
                .gte("started_at", since_iso)
                .execute()
            )
            return int(result.count or 0)
        except Exception as e:
            logging.warning("SupabaseDatabase.count_recent_conversations_by_ip failed: %s", e)
            return 0


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

def extract_campaigns_from_memory(memory: List[Dict[str, Any]]) -> List[CampaignModel]:
    """
    Parse execution memory and extract one CampaignModel per detected campaign.

    Trigger: any memory entry whose tool result is a run_workflow output
    (recognized by the {workflow, status, steps_executed, ...} shape returned
    by run_workflow), OR whose result data carries an explicit campaign_name.

    Dedupes by name so a single mission with multiple workflow steps
    surfaces as one campaign row.
    """
    seen: set[str] = set()
    campaigns: List[CampaignModel] = []
    for entry in memory:
        data = entry.get("result", {}).get("data")
        if not isinstance(data, dict):
            continue

        name = data.get("campaign_name") or data.get("workflow")
        if not isinstance(name, str) or not name.strip():
            continue

        normalized = name.strip()
        if normalized.lower() in seen:
            continue
        seen.add(normalized.lower())

        raw_status = data.get("campaign_status") or data.get("status") or "completed"
        status = raw_status if raw_status in {"draft", "active", "paused", "completed", "archived"} else "completed"

        campaigns.append(CampaignModel(name=normalized, status=status))
    return campaigns


def extract_leads_from_memory(memory: List[Dict[str, Any]]) -> List[LeadModel]:
    """
    Parse execution memory entries and extract any discovered leads.

    Maps find_leads_tool output ({name, company, role, email, score, reason})
    to the Supabase leads schema. company is required by the table's NOT NULL
    constraint, so missing values fall back to "Unknown" rather than failing
    the insert.
    """
    leads: List[LeadModel] = []
    for entry in memory:
        data = entry.get("result", {}).get("data")
        if not isinstance(data, list):
            continue
        for item in data:
            if not (isinstance(item, dict) and "name" in item and "score" in item):
                continue
            raw_email = item.get("email")
            email = raw_email.strip().lower() if isinstance(raw_email, str) and raw_email.strip() else None
            leads.append(LeadModel(
                full_name=item["name"],
                company_name=item.get("company") or "Unknown",
                role=item.get("role"),
                email=email,
                icp_score=float(item["score"]),
                qualification_status="pending",
                qualification_rationale=item.get("reason"),
                source="agent",
            ))
    return leads
