# API Reference — ProPlan Agent Orchestrator v2.0

> Full class and method reference for [`proplanOrchestrator.py`](file:///c:/Users/TheoTorku/OneDrive/Desktop/march%202026/Proplan_Operating_System/proplanOrchestrator.py).

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
| `evaluate` | `(goal: Goal, batch_results: List[TaskResult]) → str` | Returns `"complete"` if criteria are met, `"continue common"` otherwise. |

**Evaluation modes:**
- `"all_success"` — Every result in the batch must be successful.
- `"any_success"` — At least one successful result is sufficient.
- Empty batch always returns `"continue"`.

---

## Memory

### `ExecutionMemory`

Stores task/result history for context retrieval and failure tracking.

| Method | Signature | Description |
|--------|-----------|-------------|
| `add` | `(task: Task, result: TaskResult) → None` | Append a task-result pair to history. |
| `get_context` | `() → List[Dict[str, Any]]` | Return the last 5 history entries. |
| `failure_count` | `() → int` | Count total failures across all history. |

---

## LLM Providers

### `LLMProvider` (Protocol)

Abstract interface for LLM backends. Any class implementing `complete()` satisfies this protocol.

```python
class LLMProvider(Protocol):
    def complete(self, prompt: str, context: Dict[str, Any] = None) -> str: ...
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

## Agents

### `BaseAgent`

Base class for all agents. Injects an `LLMProvider` for decision-making.

| Method | Signature | Description |
|--------|-----------|-------------|
| `call_llm` | `(task: Task) → Dict[str, Any]` | Query the LLM provider for a tool-call decision. |
| `run` | `(task: Task) → TaskResult` | Execute the full agent cycle: LLM → tool → result. |

### `SalesAgent(BaseAgent)`

Default LLM: `MockAgentLLM("find_leads_tool", {"query": "find leads"})`

### `MarketingAgent(BaseAgent)`

Default LLM: `MockAgentLLM("generate_copy_tool", {"input": "generate copy"})`

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
| `call_llm` | `(request: str, context: Dict = None) → str` | Delegate to the LLM provider. |
| `plan` | `(request: str, context: Dict = None) → List[Task]` | Parse LLM output into `Task` objects. |

---

## Orchestrator

### `Orchestrator`

Central entry point. Manages the full plan → dispatch → evaluate loop.

| Constructor | `Orchestrator(security_policy: Optional[SecurityPolicy] = None)` |
|-------------|--------------------------------------------------------------|

| Method | Signature | Description |
|--------|-----------|-------------|
| `register_tool` | `(tool: Tool) → None` | Register a tool. |
| `register_agent` | `(agent_cls: type, llm_provider: Optional[LLMProvider] = None) → None` | Instantiate and register an agent class. |
| `execute_task` | `(task: Task) → TaskResult` | Execute a task with iterative retries. Only the final result is stored. |
| `run` | `(request: str) → Dict[str, Any]` | Full orchestration loop. Returns status, cost, logs, and memory. |

**Return value of `run()`:**

```python
{
    "status": "completed",
    "run_id": str,
    "total_cost": float,
    "cost_breakdown": Dict[str, float],
    "logs": List[Dict],
    "memory": List[Dict]
}
```
