# API Reference — ProPlan Agent Orchestrator v2.0

> Full class and method reference for [`proplanOrchestrator.py`](proplanOrchestrator.py), [`api.py`](api.py), [`database.py`](database.py), and [`llm.py`](llm.py).

---

## Observability

### `Logger`

Structured in-memory logger with stdout output.

| Method | Signature | Description |
|--------|-----------|-------------|
| `log` | `(level: str, message: str, meta: Dict = None) → None` | Record a log entry with timestamp, level, message, and optional metadata. |

**Properties:**
- `logs: List[Dict[str, Any]]` — All recorded log entries.

---

### `CostTracker`

Dataclass tracking cumulative execution costs.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `total_cost` | `float` | `0.0` | Sum of all costs. |
| `per_task` | `Dict[str, float]` | `{}` | Cost breakdown by task ID. |

| Method | Signature | Description |
|--------|-----------|-------------|
| `add_cost` | `(task_id: str, amount: float) → None` | Increment both total and per-task cost. |

---

## Data Models

### `Task`

Dataclass representing a unit of work.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | `str` | *required* | Unique task identifier. |
| `agent` | `str` | *required* | Name of the agent to handle this task. |
| `action` | `str` | *required* | Action type (e.g., `"execute"`). |
| `payload` | `Dict[str, Any]` | *required* | Arguments for the agent/tool. |
| `retries` | `int` | `0` | Current retry count. |
| `max_retries` | `int` | `2` | Maximum retries before giving up. |

---

### `TaskResult`

Dataclass representing the outcome of a task.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `task_id` | `str` | *required* | ID of the parent task. |
| `success` | `bool` | *required* | Whether the task succeeded. |
| `data` | `Any` | `None` | Result data on success. |
| `error` | `str` | `None` | Error message on failure. |

---

### `Goal`

Dataclass defining run-level success criteria.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `description` | `str` | *required* | Natural-language goal description. |
| `success_criteria` | `str` | `"all_success"` | `"any_success"` or `"all_success"`. |
| `max_steps` | `int` | `5` | Max iterations of the plan-dispatch-evaluate loop. |
| `max_failures` | `int` | `3` | Abort run after this many total failures. |

---

## Evaluator

### `Evaluator`

Determines whether a goal has been met based on the **current batch** of results (not all history).

| Method | Signature | Description |
|--------|-----------|-------------|
| `evaluate` | `(goal: Goal, batch_results: List[TaskResult]) → str` | Returns `"complete"` if criteria are met, `"continue"` otherwise. |

**Evaluation modes:**
- `"all_success"` — Every result in the batch must be successful.
- `"any_success"` — At least one successful result is sufficient.
- Empty batch always returns `"continue"`.

---

## Memory

### `ExecutionMemory`

Stores task/result history for context retrieval and failure tracking.

| Field | Type | Description |
|-------|------|-------------|
| `history` | `List[Dict[str, Any]]` | Full list of all task-result pairs. |

| Method | Signature | Description |
|--------|-----------|-------------|
| `add` | `(task: Task, result: TaskResult) → None` | Append a task-result pair to history. |
| `get_context` | `() → List[Dict[str, Any]]` | Return the last 5 history entries (for LLM context injection). |
| `failure_count` | `() → int` | Count total failures across all history. |

> **Note:** `run()` returns `self.memory.history` (full list), not `get_context()` (last 5). `get_context()` is only used when injecting memory into LLM prompts.

---

## LLM Providers

### `LLMProvider` (Protocol)

Abstract interface for LLM backends. Any class implementing `complete()` satisfies this protocol.

```python
class LLMProvider(Protocol):
    def complete(self, prompt: str, context: Optional[Dict[str, Any]] = None) -> str: ...
```

---

### `MockAgentLLM`

Returns a fixed tool-call JSON. Used as the default LLM for agents.

| Parameter | Type | Description |
|-----------|------|-------------|
| `tool_name` | `str` | Tool the mock will always select. |
| `default_payload` | `Dict[str, Any]` | Payload to include in the response. |

---

### `MockPlannerLLM`

Returns a fixed multi-agent plan JSON. Used as the default LLM for the planner.

---

### `AnthropicPlannerProvider` (in `llm.py`)

Calls Claude Sonnet for plan generation. Strips code fences before JSON parsing.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `api_key` | `str` | *required* | Anthropic API key. |
| `model` | `str` | `"claude-sonnet-4-20250514"` | Model ID. |

---

### `AnthropicAgentProvider` (in `llm.py`)

Calls Claude Sonnet for agent tool-call decisions.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `api_key` | `str` | *required* | Anthropic API key. |
| `agent_name` | `str` | *required* | Agent identity for system prompt. |
| `available_tools` | `str` | *required* | Comma-separated tool names. |
| `model` | `str` | `"claude-sonnet-4-20250514"` | Model ID. |

---

## Security

### `SecurityPolicy`

Dataclass configuring agent permissions and limits.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `allowed_tools` | `Dict[str, List[str]]` | `{}` | Agent name → permitted tool names. Empty = allow all. |
| `rate_limits` | `Dict[str, int]` | `{}` | Agent name → max tool calls per run. Empty = unlimited. |
| `budget_limit` | `float` | `10.0` | Maximum total cost before execution halts. |

| Class Method | Signature | Description |
|-------------|-----------|-------------|
| `allow_all` | `() → SecurityPolicy` | Factory for a wide-open dev policy. |

---

### `SecurityLayer`

Enforces permissions, rate limits, and budget at tool execution time.

| Method | Signature | Description |
|--------|-----------|-------------|
| `can_use` | `(agent_name: str, tool_name: str) → bool` | Check tool permission. |
| `check_rate_limit` | `(agent_name: str) → bool` | Check if agent is under its call limit. |
| `check_budget` | `() → bool` | Check if total cost is within budget. |
| `record_call` | `(agent_name: str) → None` | Increment the agent's call counter. |
| `authorize` | `(agent_name: str, tool_name: str) → tuple[bool, str \| None]` | Combined gate: budget → permission → rate. Returns `(authorized, reason)`. |
| `reset` | `() → None` | Clear call counters (called at each run start). |

---

## Tools

### `Tool`

Dataclass representing an executable tool.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | `str` | *required* | Unique tool identifier. |
| `schema` | `Dict[str, type]` | *required* | Expected payload field names and types. |
| `function` | `Callable` | *required* | The function to execute. |
| `cost_estimate` | `float` | `0.01` | Estimated cost per execution (for budget tracking). |

---

### `ToolRegistry`

Manages tool registration, validation, and execution.

| Method | Signature | Description |
|--------|-----------|-------------|
| `register` | `(tool: Tool) → None` | Register a tool by name. |
| `get` | `(name: str) → Optional[Tool]` | Look up a tool. |
| `list_tools` | `() → List[str]` | Return all registered tool names. |
| `validate` | `(tool: Tool, payload: Dict) → bool` | Type-check payload against schema. |
| `execute` | `(task_id: str, name: str, payload: Dict, agent_name: str) → Any` | Execute a tool after security checks. |

---

### LLM Tool Helper

Module-level cached Anthropic client (`_get_tool_client()`) used by all tool functions. Thread-safe initialization via double-checked locking.

| Function | Description |
|----------|-------------|
| `_llm_tool_call(system, user, max_tokens)` | Call Claude Haiku for tool execution. Returns `None` if no API key or on failure. |
| `_strip_code_fence(text)` | Remove markdown `` ```json ``` `` fences from LLM output before JSON parsing. |

---

## Agents

### `BaseAgent`

Base class for all agents. Injects an `LLMProvider` for decision-making.

| Method | Signature | Description |
|--------|-----------|-------------|
| `call_llm` | `(task: Task) → Dict[str, Any]` | Query the LLM provider for a tool-call decision. Strips code fences before parsing. |
| `run` | `(task: Task) → TaskResult` | Execute the full agent cycle: LLM → security check → tool → result. |

### `SalesAgent(BaseAgent)`

Default LLM: `MockAgentLLM("find_leads_tool", {"query": "find leads"})`

### `MarketingAgent(BaseAgent)`

Default LLM: `MockAgentLLM("generate_copy_tool", {"input": "generate copy"})`

### `SupportAgent(BaseAgent)`

Default LLM: `MockAgentLLM("search_knowledge_base", {"query": "support query"})`

### `OpsAgent(BaseAgent)`

Default LLM: `MockAgentLLM("schedule_task", {"task_name": "ops task"})`

---

## Registries

### `AgentRegistry`

| Method | Signature | Description |
|--------|-----------|-------------|
| `register` | `(agent: BaseAgent) → None` | Register an agent instance. |
| `get` | `(name: str) → Optional[BaseAgent]` | Look up an agent by name. |

---

## Planner

### `LLMPlanner`

Generates task plans from user requests using an LLM provider.

| Method | Signature | Description |
|--------|-----------|-------------|
| `call_llm` | `(request: str, context: Optional[Dict] = None) → str` | Delegate to the LLM provider. |
| `plan` | `(request: str, context: Optional[Dict] = None) → List[Task]` | Parse LLM output into `Task` objects. |

---

## Orchestrator

### `Orchestrator`

Central entry point. Manages the full plan → dispatch → evaluate loop.

| Constructor | `Orchestrator(security_policy: Optional[SecurityPolicy] = None, planner_llm: Optional[LLMProvider] = None)` |
|-------------|--------------------------------------------------------------------------------------------------------------|

| Method | Signature | Description |
|--------|-----------|-------------|
| `register_tool` | `(tool: Tool) → None` | Register a tool. |
| `register_agent` | `(agent_cls: type, llm_provider: Optional[LLMProvider] = None) → None` | Instantiate and register an agent class. |
| `execute_task` | `(task: Task) → TaskResult` | Execute a task with iterative retries. Only the final result is stored. |
| `run` | `(request: str, business_context: Optional[str] = None) → Dict[str, Any]` | Full orchestration loop. Returns status, cost, logs, and full memory. |

**Return value of `run()`:**

```python
{
    "status": "goal_met" | "max_steps_reached" | "max_failures_reached" | "budget_exceeded",
    "run_id": str,
    "total_cost": float,
    "cost_breakdown": Dict[str, float],
    "logs": List[Dict],
    "memory": List[Dict]   # Full execution history (self.memory.history)
}
```

---

## FastAPI Endpoints (`api.py`)

### `POST /agent/run`

Dispatch an async orchestrator run. Returns immediately.

**Request:** `AgentRunRequest`
```json
{ "user_id": "string", "request": "string", "business_context": "string | null" }
```

**Response:** `AgentRunDispatchResponse`
```json
{ "status": "running", "run_id": "uuid" }
```

### `GET /agent/run/status/{run_id}`

Poll for run result.

**Response:**
```json
{ "status": "running" | "completed" | "failed", "result": {...} | null, "error": "string" | null }
```

### `GET /leads`

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `min_score` | `float` | `None` | Minimum ICP score filter. |
| `limit` | `int` | `None` | Max results (1-500). |
| `offset` | `int` | `0` | Pagination offset. |

### `GET /leads/export.csv`

Stream leads as a CSV download. Honors the same filters as `GET /leads`.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `min_score` | `float` | `None` | Minimum ICP score filter. |
| `limit` | `int` | `None` | Max rows (1-5000). |
| `offset` | `int` | `0` | Pagination offset. |

Response: `text/csv; charset=utf-8` with `Content-Disposition: attachment; filename="proplan-leads-YYYYMMDD-HHMMSS.csv"`. Columns: `full_name, email, phone, company_name, role, inquiry_type, icp_score, qualification_status, qualification_rationale, source, created_at, id`.

### `POST /campaigns`

```json
{ "name": "string", "status": "draft" }
```

### `GET /campaigns`

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | `int` | `None` | Max results (1-500). |
| `offset` | `int` | `0` | Pagination offset. |

### `GET /campaigns/export.csv`

Stream campaigns as a CSV download.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | `int` | `None` | Max rows (1-5000). |
| `offset` | `int` | `0` | Pagination offset. |

Response: `text/csv` with timestamped filename. Columns: `name, status, id, created_at, updated_at`.

### `POST /integrations/slack/{user_id}/test`

Send a short ping to the user's configured Slack incoming webhook. Returns `{"status": "sent"}` on success, 400 if the webhook isn't configured or doesn't start with `https://hooks.slack.com/`, 502 if Slack rejects the message.

### `POST /integrations/slack/{user_id}/leads`

Post a top-N lead digest (sorted by score, descending) to the user's Slack webhook.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `min_score` | `float` | `None` | Minimum ICP score filter. |
| `limit` | `int` | `10` | Max leads in the digest (1-50). |

Response: `{"status": "sent", "count": N}`. Same 400/502 semantics as the test endpoint.

### `GET /profile/{user_id}`

Returns the saved `BusinessProfileModel` or 404.

### `PUT /profile/{user_id}`

Create or update a business profile. Body: `BusinessProfileModel`.

### `GET /runs`

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `user_id` | `str` | *required* | Filter by user. |
| `limit` | `int` | `20` | Max results (1-100). |

### `GET /health`

Returns `{ "status": "healthy", "timestamp": float }`.

---

## Database Models (`database.py`)

### `LeadModel`
Lead record matching the Supabase `leads` table. Key fields: `full_name`, `email`, `company_name`, `icp_score` (0-100), `qualification_status`, `source`.

### `CampaignModel`
Campaign record: `name`, `status` (default `"draft"`).

### `AgentSessionModel`
Run log: `run_id`, `user_id`, `agent_type`, `status`, `cost_usd`, `started_at`, `completed_at`.

### `BusinessProfileModel`
Per-user business context: `company_name`, `what_we_do`, `icp`, `target_industries`, `company_size`, `geography`, `lead_signals`, `value_proposition`, `tone`, `slack_webhook_url`.

> `slack_webhook_url` is stored as plaintext on `business_profiles`. Access is gated by the same API key as the profile endpoints. Added in migration `0005_add_slack_webhook_url.sql`.

### Database Providers

| Provider | Use | Description |
|----------|-----|-------------|
| `InMemoryDatabase` | Development | Thread-safe dict-based storage. |
| `SupabaseDatabase` | Production | Supabase client with full CRUD. |

Factory: `get_database()` returns `SupabaseDatabase` if `SUPABASE_URL`/`SUPABASE_KEY` are set, else `InMemoryDatabase`.

### `extract_leads_from_memory(memory)`

Parses full execution memory and extracts discovered leads (maps `name`/`score` → `full_name`/`icp_score`).
