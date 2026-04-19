"""
ProPlan Agent Orchestrator v2.0

Changes from v1.0:
- Fix 1: Evaluator evaluates per-batch with configurable success criteria
- Fix 2: Retry uses iterative loop, records only final result
- Fix 3: LLMProvider protocol for swappable LLM backends
- Fix 4: SecurityLayer with permissions, rate limiting, budget enforcement
"""

from typing import List, Dict, Any, Callable, Optional, Protocol, runtime_checkable, Type
from pydantic import BaseModel, ValidationError
from dataclasses import dataclass, field
import uuid
import time
import json
import logging
import os
import re
import threading
from datetime import datetime, timedelta

logger = logging.getLogger(__name__)

# Model IDs — centralised so they're easy to update
TOOL_MODEL = "claude-haiku-4-5-20251001"

_CODE_FENCE_RE = re.compile(r"^```(?:json)?\s*\n?(.*?)\n?```\s*$", re.DOTALL)


def _strip_code_fence(text: str) -> str:
    """Remove surrounding markdown code fences (```json ... ``` or ``` ... ```) if present."""
    m = _CODE_FENCE_RE.match(text.strip())
    return m.group(1).strip() if m else text.strip()


def _task_signature(agent: str, payload: Dict[str, Any]) -> str:
    """Stable `agent + payload` key used to dedupe tasks across planner iterations."""
    try:
        body = json.dumps(payload, sort_keys=True, default=str)
    except Exception:
        body = str(payload)
    return f"{agent}::{body}"


# -----------------------------
# Observability Layer
# -----------------------------

class Logger:
    """Structured logger with in-memory storage and stdlib logging output."""

    def __init__(self):
        self.logs: List[Dict[str, Any]] = []

    def log(self, level: str, message: str, meta: Optional[Dict[str, Any]] = None):
        """Record a log entry with timestamp, level, message, and optional metadata."""
        entry = {
            "timestamp": time.time(),
            "level": level,
            "message": message,
            "meta": meta or {}
        }
        self.logs.append(entry)
        log_fn = {
            "INFO": logger.info,
            "WARN": logger.warning,
            "ERROR": logger.error,
        }.get(level, logger.debug)
        log_fn("%s | %s", message, meta or {})


@dataclass
class CostTracker:
    """Tracks cumulative execution cost per task and overall."""

    total_cost: float = 0.0
    per_task: Dict[str, float] = field(default_factory=dict)

    def add_cost(self, task_id: str, amount: float):
        """Add cost for a specific task execution."""
        self.total_cost += amount
        self.per_task[task_id] = self.per_task.get(task_id, 0) + amount


# -----------------------------
# Task + Result Models
# -----------------------------

@dataclass
class Task:
    """Represents a unit of work dispatched to an agent."""

    id: str
    agent: str
    action: str
    payload: Dict[str, Any]
    retries: int = 0
    max_retries: int = 2


@dataclass
class TaskResult:
    """Outcome of a task execution."""

    task_id: str
    success: bool
    data: Any = None
    error: Optional[str] = None


# -----------------------------
# Goal + Evaluation (FIX 1)
# -----------------------------

@dataclass
class Goal:
    """Defines what constitutes a successful run."""

    description: str
    success_criteria: str = "all_success"  # "any_success" | "all_success"
    max_steps: int = 5
    max_failures: int = 3


class Evaluator:
    """Evaluates whether a goal has been met based on the current batch of results."""

    def evaluate(self, goal: Goal, batch_results: List[TaskResult]) -> str:
        """
        Evaluate goal completion against the current batch only.

        Args:
            goal: The goal with success criteria.
            batch_results: Results from the current iteration only.

        Returns:
            "complete" if criteria are met, "continue" otherwise.
        """
        if not batch_results:
            return "continue"

        if goal.success_criteria == "any_success":
            if any(r.success for r in batch_results):
                return "complete"
        elif goal.success_criteria == "all_success":
            if all(r.success for r in batch_results):
                return "complete"

        return "continue"


# -----------------------------
# Memory System
# -----------------------------

@dataclass
class ExecutionMemory:
    """Stores execution history for context retrieval and failure tracking."""

    history: List[Dict[str, Any]] = field(default_factory=list)

    def add(self, task: Task, result: TaskResult):
        """Record a task and its result in history."""
        self.history.append({
            "task": task.__dict__,
            "result": result.__dict__
        })

    def get_context(self) -> List[Dict[str, Any]]:
        """Return the last 5 history entries for LLM context."""
        return self.history[-5:]

    def failure_count(self) -> int:
        """Count total failures in history."""
        return sum(1 for h in self.history if not h["result"]["success"])

    def clear(self):
        """Clear execution history (used at the start of a new run)."""
        self.history.clear()


# -----------------------------
# LLM Provider (FIX 3)
# -----------------------------

@runtime_checkable
class LLMProvider(Protocol):
    """Protocol for swappable LLM backends."""

    def complete(self, prompt: str, context: Optional[Dict[str, Any]] = None) -> str:
        """Generate a completion from a prompt and optional context."""
        ...


class MockAgentLLM:
    """Mock LLM for agents — returns a fixed tool call. Swap with a real provider in production."""

    def __init__(self, tool_name: str, default_payload: Dict[str, Any]):
        self.tool_name = tool_name
        self.default_payload = default_payload

    def complete(self, prompt: str, context: Optional[Dict[str, Any]] = None) -> str:
        """Return a fixed JSON tool call."""
        return json.dumps({"tool": self.tool_name, "payload": self.default_payload})


class MockPlannerLLM:
    """Mock LLM for the planner — returns a fixed plan. Swap with a real provider in production."""

    def complete(self, prompt: str, context: Optional[Dict[str, Any]] = None) -> str:
        """Return a fixed JSON plan using the prompt as payload content."""
        return json.dumps([
            {"agent": "sales", "action": "execute", "payload": {"query": prompt}},
            {"agent": "marketing", "action": "execute",
                "payload": {"input": prompt}},
            {"agent": "support", "action": "execute", "payload": {"query": prompt}},
            {"agent": "ops", "action": "execute", "payload": {"task_name": prompt}}
        ])


# -----------------------------
# Security Layer (FIX 4)
# -----------------------------

@dataclass
class SecurityPolicy:
    """Configuration for agent permissions, rate limits, and budget."""

    allowed_tools: Dict[str, List[str]] = field(
        default_factory=dict)  # agent_name -> [tool_names]
    # agent_name -> max calls per run
    rate_limits: Dict[str, int] = field(default_factory=dict)
    # max total cost before halt
    budget_limit: float = 10.0

    @classmethod
    def allow_all(cls) -> "SecurityPolicy":
        """Create a wide-open policy for development — no restrictions."""
        return cls(allowed_tools={}, rate_limits={}, budget_limit=10.0)


class SecurityLayer:
    """Enforces tool permissions, rate limits, and budget constraints."""

    def __init__(self, policy: SecurityPolicy, cost_tracker: CostTracker, logger: Logger):
        self.policy = policy
        self.cost_tracker = cost_tracker
        self.logger = logger
        self._call_counts: Dict[str, int] = {}

    def can_use(self, agent_name: str, tool_name: str) -> bool:
        """Check if an agent is permitted to use a specific tool."""
        allowed = self.policy.allowed_tools.get(agent_name)
        if allowed is None:
            return True  # no restrictions defined = allow all
        return tool_name in allowed

    def check_rate_limit(self, agent_name: str) -> bool:
        """Check if an agent has exceeded its rate limit."""
        limit = self.policy.rate_limits.get(agent_name)
        if limit is None:
            return True  # no limit defined = allow
        current = self._call_counts.get(agent_name, 0)
        return current < limit

    def check_budget(self) -> bool:
        """Check if the total cost is still within budget."""
        return self.cost_tracker.total_cost < self.policy.budget_limit

    def record_call(self, agent_name: str):
        """Increment the call counter for rate limiting."""
        self._call_counts[agent_name] = self._call_counts.get(
            agent_name, 0) + 1

    def authorize(self, agent_name: str, tool_name: str) -> tuple:
        """
        Combined authorization gate.

        Returns:
            (authorized: bool, reason: str or None)
        """
        if not self.check_budget():
            reason = f"Budget exceeded: ${self.cost_tracker.total_cost:.2f} >= ${self.policy.budget_limit:.2f}"
            self.logger.log("WARN", reason, {
                            "agent": agent_name, "tool": tool_name})
            return False, reason

        if not self.can_use(agent_name, tool_name):
            reason = f"Agent '{agent_name}' not permitted to use tool '{tool_name}'"
            self.logger.log("WARN", reason, {
                            "agent": agent_name, "tool": tool_name})
            return False, reason

        if not self.check_rate_limit(agent_name):
            reason = f"Rate limit exceeded for agent '{agent_name}'"
            self.logger.log("WARN", reason, {
                            "agent": agent_name, "tool": tool_name})
            return False, reason

        return True, None

    def reset(self):
        """Reset call counters (call at the start of each run)."""
        self._call_counts.clear()


# -----------------------------
# Tool System
# -----------------------------

@dataclass
class Tool:
    """Represents an executable tool available to agents."""

    name: str
    schema: Type[BaseModel]
    function: Callable
    cost_estimate: float = 0.01


class ToolRegistry:
    """Registry for tool management, validation, and execution."""

    def __init__(self, logger: Logger, cost_tracker: CostTracker, security: SecurityLayer):
        self.tools: Dict[str, Tool] = {}
        self.logger = logger
        self.cost_tracker = cost_tracker
        self.security = security

    def register(self, tool: Tool):
        """Register a tool by name."""
        self.tools[tool.name] = tool
        self.logger.log("INFO", f"Tool registered: {tool.name}")

    def get(self, name: str) -> Optional[Tool]:
        """Look up a tool by name."""
        return self.tools.get(name)

    def list_tools(self) -> List[str]:
        """Return all registered tool names."""
        return list(self.tools.keys())

    def validate(self, tool: Tool, payload: Dict[str, Any]) -> bool:
        """Validate payload types against a tool's Pydantic schema."""
        ok, _ = self.validate_with_errors(tool, payload)
        return ok

    def validate_with_errors(self, tool: Tool, payload: Dict[str, Any]):
        """Like validate() but also returns the Pydantic error list for retries."""
        try:
            tool.schema(**payload)
            return True, []
        except ValidationError as e:
            errors = e.errors()
            self.logger.log("WARN", f"Validation failed for tool '{tool.name}'", {
                            "errors": errors})
            return False, errors

    def execute(self, task_id: str, name: str, payload: Dict[str, Any], agent_name: str = "unknown") -> Any:
        """
        Execute a tool after passing security checks.

        Args:
            task_id: ID of the parent task.
            name: Tool name.
            payload: Arguments for the tool.
            agent_name: Name of the requesting agent (for security).

        Raises:
            Exception: If tool not found, security check fails, or validation fails.
        """
        tool = self.get(name)

        if not tool:
            raise Exception(f"Tool '{name}' not found")

        # Security gate
        authorized, reason = self.security.authorize(agent_name, name)
        if not authorized:
            raise Exception(f"Security blocked: {reason}")

        if not self.validate(tool, payload):
            raise Exception(f"Invalid payload for tool '{name}'")

        self.logger.log("INFO", f"Executing tool: {name}", {
                        "task_id": task_id, "agent": agent_name})

        result = tool.function(payload)

        # Track cost and rate
        self.cost_tracker.add_cost(task_id, tool.cost_estimate)
        self.security.record_call(agent_name)

        return result


# -----------------------------
# Base Agent (FIX 3 - LLM injection)
# -----------------------------

class BaseAgent:
    """Base class for all agents. Accepts an LLMProvider for tool-call decisions."""

    name = "base"

    def __init__(self, tools: ToolRegistry, memory: ExecutionMemory, logger: Logger,
                 llm_provider: Optional[LLMProvider] = None):
        self.tools = tools
        self.memory = memory
        self.logger = logger
        self.llm_provider = llm_provider or MockAgentLLM(
            "find_leads_tool", {"query": "fallback"})

    def call_llm(self, task: Task, retry_hint: Optional[str] = None) -> Dict[str, Any]:
        """Use the injected LLM provider to decide which tool to call.
        retry_hint, when supplied, is appended to the prompt so the LLM can
        repair its previous payload (e.g. after schema validation failed).
        """
        body = {"action": task.action, "payload": task.payload}
        if retry_hint:
            body["retry_hint"] = retry_hint
        prompt = json.dumps(body)
        context = {"agent": self.name, "memory": self.memory.get_context()}
        raw = self.llm_provider.complete(prompt, context)
        return json.loads(_strip_code_fence(raw))

    def run(self, task: Task) -> TaskResult:
        """Execute a task by consulting the LLM and dispatching a tool call.
        On schema-validation failure we re-prompt the LLM once with the
        Pydantic error list so it can correct its payload before we give up.
        """
        try:
            self.logger.log("INFO", "Agent running", {
                            "agent": self.name, "task_id": task.id})

            decision = self.call_llm(task)
            tool_name = decision.get("tool")
            payload = decision.get("payload", {})

            if tool_name not in self.tools.list_tools():
                return TaskResult(task.id, False, error=f"Invalid tool: {tool_name}")

            tool = self.tools.get(tool_name)
            ok, errors = self.tools.validate_with_errors(tool, payload)
            if not ok:
                hint = (
                    f"Your previous payload failed schema validation for tool "
                    f"'{tool_name}'. Errors: {json.dumps(errors)}. "
                    f"Re-emit the same tool call using ONLY the field names from "
                    f"the example in the system prompt."
                )
                self.logger.log("INFO", "Retrying agent call with schema hint", {
                                "task_id": task.id, "tool": tool_name})
                decision = self.call_llm(task, retry_hint=hint)
                tool_name = decision.get("tool")
                payload = decision.get("payload", {})
                if tool_name not in self.tools.list_tools():
                    return TaskResult(task.id, False, error=f"Invalid tool: {tool_name}")

            result = self.tools.execute(
                task.id, tool_name, payload, agent_name=self.name)

            return TaskResult(task.id, True, result)

        except Exception as e:
            self.logger.log("ERROR", str(e), {"task_id": task.id})
            return TaskResult(task.id, False, error=str(e))


class SalesAgent(BaseAgent):
    """Specialized agent for sales tasks (lead scraping, scoring, outreach)."""

    name = "sales"

    def __init__(self, tools: ToolRegistry, memory: ExecutionMemory, logger: Logger,
                 llm_provider: Optional[LLMProvider] = None):
        default_llm = llm_provider or MockAgentLLM(
            "find_leads_tool", {"query": "find leads"})
        super().__init__(tools, memory, logger, default_llm)


class MarketingAgent(BaseAgent):
    """Specialized agent for marketing tasks (copy generation, campaigns)."""

    name = "marketing"

    def __init__(self, tools: ToolRegistry, memory: ExecutionMemory, logger: Logger,
                 llm_provider: Optional[LLMProvider] = None):
        default_llm = llm_provider or MockAgentLLM(
            "generate_copy_tool", {"input": "generate copy"})
        super().__init__(tools, memory, logger, default_llm)


class SupportAgent(BaseAgent):
    """Specialized agent for customer support (chat responses, knowledge retrieval)."""

    name = "support"

    def __init__(self, tools: ToolRegistry, memory: ExecutionMemory, logger: Logger,
                 llm_provider: Optional[LLMProvider] = None):
        default_llm = llm_provider or MockAgentLLM(
            "search_knowledge_base", {"query": "search help"})
        super().__init__(tools, memory, logger, default_llm)


class OpsAgent(BaseAgent):
    """Specialized agent for operations (scheduling, workflow automation)."""

    name = "ops"

    def __init__(self, tools: ToolRegistry, memory: ExecutionMemory, logger: Logger,
                 llm_provider: Optional[LLMProvider] = None):
        default_llm = llm_provider or MockAgentLLM(
            "schedule_task", {"task_name": "default task"})
        super().__init__(tools, memory, logger, default_llm)


# -----------------------------
# Agent Registry
# -----------------------------

class AgentRegistry:
    """Registry for looking up agents by name."""

    def __init__(self):
        self.agents: Dict[str, BaseAgent] = {}

    def register(self, agent: BaseAgent):
        """Register an agent instance."""
        self.agents[agent.name] = agent

    def get(self, name: str) -> Optional[BaseAgent]:
        """Look up an agent by name."""
        return self.agents.get(name)


# -----------------------------
# Planner (FIX 3 - LLM injection)
# -----------------------------

class LLMPlanner:
    """Generates task plans from user requests using an LLM provider."""

    def __init__(self, registry: AgentRegistry, llm_provider: Optional[LLMProvider] = None):
        self.registry = registry
        self.llm_provider = llm_provider or MockPlannerLLM()

    def call_llm(self, request: str, context: Optional[Dict[str, Any]] = None) -> str:
        """Delegate plan generation to the LLM provider."""
        return self.llm_provider.complete(request, context)

    def plan(self, request: str, context: Optional[Dict[str, Any]] = None) -> List[Task]:
        """
        Generate a list of tasks from a user request.

        Args:
            request: The user's natural-language request.
            context: Optional memory/context for adaptive replanning.

        Returns:
            List of Task objects, or empty list on failure.
        """
        try:
            parsed = json.loads(self.call_llm(request, context))
            return [
                Task(
                    id=str(uuid.uuid4()),
                    agent=s["agent"],
                    action=s["action"],
                    payload=s.get("payload", {})
                )
                for s in parsed
            ]
        except Exception as e:
            logger.error("Planner failed to generate tasks: %s",
                         e, exc_info=True)
            return []


# -----------------------------
# Orchestrator (FIX 1, 2, 3, 4 integrated)
# -----------------------------

class Orchestrator:
    """Central brain that manages agents, tools, and the plan-dispatch-evaluate loop."""

    def __init__(self, security_policy: Optional[SecurityPolicy] = None, planner_llm: Optional[LLMProvider] = None):
        self.logger = Logger()
        self.cost_tracker = CostTracker()
        self.memory = ExecutionMemory()
        self.registry = AgentRegistry()

        # Security (FIX 4)
        policy = security_policy or SecurityPolicy.allow_all()
        self.security = SecurityLayer(policy, self.cost_tracker, self.logger)

        self.tools = ToolRegistry(
            self.logger, self.cost_tracker, self.security)
        self.planner = LLMPlanner(self.registry, llm_provider=planner_llm)
        self.evaluator = Evaluator()

    def register_tool(self, tool: Tool):
        """Register a tool in the tool registry."""
        self.tools.register(tool)

    def register_agent(self, agent_cls: type, llm_provider: Optional[LLMProvider] = None):
        """
        Instantiate and register an agent.

        Args:
            agent_cls: A BaseAgent subclass to instantiate.
            llm_provider: Optional LLM provider to inject into the agent.
        """
        agent = agent_cls(self.tools, self.memory, self.logger, llm_provider)
        self.registry.register(agent)

    # FIX 2: Iterative retry loop, records only final result
    def execute_task(self, task: Task) -> TaskResult:
        """
        Execute a task with iterative retries.

        Only the final result (success or last failure) is recorded in memory.
        """
        self.logger.log("INFO", "Executing task", {"task_id": task.id})

        agent = self.registry.get(task.agent)
        if not agent:
            result = TaskResult(task.id, False, error="Agent not found")
            self.memory.add(task, result)
            return result

        while True:
            result = agent.run(task)
            if result.success or task.retries >= task.max_retries:
                self.memory.add(task, result)
                return result
            task.retries += 1
            self.logger.log(
                "WARN", f"Retry {task.retries}/{task.max_retries}", {"task_id": task.id})

    def run(self, request: str, business_context: Optional[str] = None) -> Dict[str, Any]:
        """
        Execute the full orchestration loop.

        1. Create a goal from the request.
        2. Repeatedly plan, dispatch, and evaluate until the goal is met or limits are reached.

        Args:
            request: Natural-language mission from the user.
            business_context: Optional business profile injected as system context for all agents.
        """
        run_id = str(uuid.uuid4())
        self.logger.log("INFO", "Run started", {
                        "run_id": run_id, "request": request})
        self.security.reset()
        self.memory.clear()

        # Prepend business context so the planner and agents are profile-aware
        full_request = (
            f"[BUSINESS CONTEXT]\n{business_context}\n\n[MISSION]\n{request}"
            if business_context and business_context.strip()
            else request
        )

        goal = Goal(description=full_request, success_criteria="all_success")
        steps = 0
        final_status = "max_steps_reached"

        while steps < goal.max_steps:
            # Plan with context so the LLM can adapt
            context = {"memory": self.memory.get_context(), "step": steps}
            raw_tasks = self.planner.plan(full_request, context)

            # Dedupe: skip tasks already completed successfully, and collapse
            # duplicates within the same batch. Without this the planner can
            # re-emit SALES-01 on every iteration, burning budget on work
            # that's already done.
            completed_sigs = {
                _task_signature(h["task"]["agent"], h["task"]["payload"])
                for h in self.memory.history
                if h["result"]["success"]
            }
            seen_this_batch: set = set()
            tasks: List[Task] = []
            for t in raw_tasks:
                sig = _task_signature(t.agent, t.payload)
                if sig in completed_sigs or sig in seen_this_batch:
                    continue
                seen_this_batch.add(sig)
                tasks.append(t)

            # Planner only re-emitted already-completed work → goal is met.
            if raw_tasks and not tasks:
                self.logger.log("INFO", "Planner produced only duplicates; treating as goal_met",
                                {"run_id": run_id, "duped": len(raw_tasks)})
                final_status = "goal_met"
                break

            # Dispatch and collect batch results (FIX 1)
            batch_results: List[TaskResult] = []
            for task in tasks:
                result = self.execute_task(task)
                batch_results.append(result)

            # Evaluate this batch only (FIX 1)
            decision = self.evaluator.evaluate(goal, batch_results)

            if decision == "complete":
                final_status = "goal_met"
                self.logger.log("INFO", "Goal achieved", {"run_id": run_id})
                break

            if self.memory.failure_count() >= goal.max_failures:
                final_status = "max_failures_reached"
                self.logger.log("ERROR", "Too many failures",
                                {"run_id": run_id})
                break

            # Budget check (FIX 4)
            if not self.security.check_budget():
                final_status = "budget_exceeded"
                self.logger.log("ERROR", "Budget exceeded — halting run", {
                                "run_id": run_id})
                break

            steps += 1

        self.logger.log("INFO", "Run finished", {
                        "run_id": run_id, "status": final_status})
        return {
            "status": final_status,
            "run_id": run_id,
            "total_cost": self.cost_tracker.total_cost,
            "cost_breakdown": self.cost_tracker.per_task,
            "logs": self.logger.logs,
            "memory": self.memory.history
        }


# -----------------------------
# Tool Schemas
# -----------------------------

class FindLeadsSchema(BaseModel):
    query: str
    count: Optional[int] = 5


class GenerateCopySchema(BaseModel):
    input: str
    type: Optional[str] = "email"


class SearchKnowledgeBaseSchema(BaseModel):
    query: str


class ScheduleTaskSchema(BaseModel):
    task_name: str
    due_date: Optional[str] = None


class RunWorkflowSchema(BaseModel):
    workflow_name: str
    steps: Optional[List[str]] = None


# -----------------------------
# LLM Tool Helper
# -----------------------------

_tool_client = None
_tool_client_lock = threading.Lock()


def _get_tool_client():
    """Return a module-level cached Anthropic client, lazily initialised (thread-safe)."""
    global _tool_client
    if _tool_client is not None:
        return _tool_client
    with _tool_client_lock:
        # Double-check after acquiring the lock
        if _tool_client is not None:
            return _tool_client
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            return None
        from anthropic import Anthropic
        _tool_client = Anthropic(api_key=api_key)
    return _tool_client


def _llm_tool_call(system: str, user: str, max_tokens: int = 1024) -> Optional[str]:
    """Call Anthropic Claude for a tool if ANTHROPIC_API_KEY is set. Returns None on failure."""
    client = _get_tool_client()
    if not client:
        return None
    try:
        response = client.messages.create(
            model=TOOL_MODEL,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        return response.content[0].text
    except Exception as e:
        logger.warning("LLM tool call failed: %s", e)
        return None


# -----------------------------
# Real Tools (LLM-powered, mock fallback)
# -----------------------------

def find_leads_tool(payload):
    """Find and score B2B leads. Uses Anthropic Claude if API key is set."""
    query = payload.get("query", "")
    count = payload.get("count", 5)

    result = _llm_tool_call(
        system=(
            "You are a B2B lead researcher. Generate realistic business leads matching the query. "
            "Return ONLY a valid JSON array. Each object must have: "
            "'name' (full name), 'company' (company name), 'role' (job title), "
            "'email' (realistic work email), 'score' (ICP fit 0-100), "
            "'reason' (one sentence why they fit). No extra text, only JSON."
        ),
        user=f"Query: {query}\nGenerate exactly {count} leads.",
        max_tokens=1500,
    )
    if result:
        try:
            # Strip markdown code fences if present
            clean = _strip_code_fence(result)
            parsed = json.loads(clean)
            if isinstance(parsed, list):
                return parsed
            # LLM sometimes wraps in {"leads": [...]} — unwrap if possible
            if isinstance(parsed, dict):
                for v in parsed.values():
                    if isinstance(v, list):
                        return v
            logger.warning("find_leads_tool: LLM returned non-list JSON, using fallback")
        except json.JSONDecodeError:
            logger.warning("find_leads_tool: JSON parse failed, using fallback")

    return [
        {"name": "Alex Chen", "company": "TechFlow Inc", "role": "VP of Sales", "email": "alex.chen@techflow.io", "score": 88, "reason": "Matches target ICP — mid-market SaaS with active sales team"},
        {"name": "Maria Santos", "company": "GrowthBase", "role": "Marketing Director", "email": "m.santos@growthbase.com", "score": 74, "reason": "High intent signals, recent Series A funding"},
        {"name": "James Okonkwo", "company": "OpsWorks Ltd", "role": "Head of Operations", "email": "j.okonkwo@opsworks.co", "score": 61, "reason": "Relevant industry, exploring automation tools"},
    ]


def generate_copy_tool(payload):
    """Generate marketing or outreach copy using Anthropic Claude if available."""
    input_text = payload.get("input", "")
    copy_type = payload.get("type", "email")

    result = _llm_tool_call(
        system=(
            f"You are a B2B copywriter specializing in {copy_type} copy. "
            "Write concise, compelling copy that drives action. "
            "Return only the copy text — no labels, headers, or meta-commentary."
        ),
        user=f"Write {copy_type} copy for: {input_text}",
        max_tokens=800,
    )
    return result or (
        "We help teams like yours move faster and close more deals. "
        "Would you be open to a 15-minute call this week to explore the fit?"
    )


def search_knowledge_base(payload):
    """Answer a support or knowledge query using Anthropic Claude if available."""
    query = payload.get("query", "")

    result = _llm_tool_call(
        system=(
            "You are a knowledgeable support agent. Answer the query clearly and concisely "
            "based on general best practices. Return a JSON object with 'answer' (string) "
            "and 'confidence' (float 0-1). Only JSON, no extra text."
        ),
        user=f"Query: {query}",
    )
    if result:
        try:
            clean = _strip_code_fence(result)
            return json.loads(clean)
        except json.JSONDecodeError:
            return {"answer": result.strip(), "confidence": 0.85}

    return {"answer": f"Based on best practices for '{query}': recommend reviewing your current process and aligning with team goals.", "confidence": 0.75}


def schedule_task(payload):
    """Schedule a task and return a confirmation."""
    task_name = payload.get("task_name", "unnamed")
    due_date = payload.get("due_date", "")

    result = _llm_tool_call(
        system=(
            "You are an operations scheduler. Given a task name, return a JSON scheduling confirmation with: "
            "'scheduled' (true), 'task_name' (string), 'scheduled_time' (ISO 8601), "
            "'priority' ('high'/'medium'/'low'), 'notes' (brief recommendation). Only JSON."
        ),
        user=f"Schedule task: {task_name}" + (f" Due: {due_date}" if due_date else ""),
    )
    if result:
        try:
            clean = _strip_code_fence(result)
            return json.loads(clean)
        except json.JSONDecodeError:
            pass

    next_business = (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%dT09:00:00")
    return {
        "scheduled": True,
        "task_name": task_name,
        "scheduled_time": next_business,
        "priority": "medium",
        "notes": "Scheduled during next available business window.",
    }


def run_workflow(payload):
    """Execute and summarize an automated workflow using Anthropic Claude if available."""
    workflow_name = payload.get("workflow_name", "default")
    steps = payload.get("steps", [])

    result = _llm_tool_call(
        system=(
            "You are a workflow execution engine. Given a workflow name and optional steps, "
            "return a JSON execution summary with: 'workflow' (name), 'status' ('completed'), "
            "'steps_executed' (int), 'duration_ms' (int), 'output' (brief summary string). Only JSON."
        ),
        user=f"Execute workflow: {workflow_name}" + (f"\nSteps: {steps}" if steps else ""),
    )
    if result:
        try:
            clean = _strip_code_fence(result)
            return json.loads(clean)
        except json.JSONDecodeError:
            pass

    return {
        "workflow": workflow_name,
        "status": "completed",
        "steps_executed": max(len(steps), 3),
        "duration_ms": 1240,
        "output": f"Workflow '{workflow_name}' executed successfully.",
    }


# -----------------------------
# Example Usage
# -----------------------------

if __name__ == "__main__":
    orchestrator = Orchestrator()

    # Register all tools
    orchestrator.register_tool(
        Tool("find_leads_tool", FindLeadsSchema, find_leads_tool, cost_estimate=0.02))
    orchestrator.register_tool(Tool(
        "generate_copy_tool", GenerateCopySchema, generate_copy_tool, cost_estimate=0.01))
    orchestrator.register_tool(Tool(
        "search_knowledge_base", SearchKnowledgeBaseSchema, search_knowledge_base, cost_estimate=0.005))
    orchestrator.register_tool(
        Tool("schedule_task", ScheduleTaskSchema, schedule_task, cost_estimate=0.005))
    orchestrator.register_tool(
        Tool("run_workflow", RunWorkflowSchema, run_workflow, cost_estimate=0.01))

    # Register all agents
    orchestrator.register_agent(SalesAgent)
    orchestrator.register_agent(MarketingAgent)
    orchestrator.register_agent(SupportAgent)
    orchestrator.register_agent(OpsAgent)

    response = orchestrator.run(
        "Find leads, generate copy, answer support questions, and schedule follow-ups")
    print(json.dumps(response, indent=2))
