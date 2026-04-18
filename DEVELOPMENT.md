# Development Guide — ProPlan Agent Orchestrator

> How to extend the orchestrator with new agents, tools, and LLM providers.

---

## Adding a New Agent

### 1. Create the Agent Class

Subclass `BaseAgent` and give it a unique `name`. Optionally set a default `MockAgentLLM` that routes to the correct tool.

```python
from proplanOrchestrator import BaseAgent, MockAgentLLM

class SupportAgent(BaseAgent):
    """Agent for customer support — answers questions using a knowledge base."""

    name = "support"

    def __init__(self, tools, memory, logger, llm_provider=None):
        default_llm = llm_provider or MockAgentLLM(
            "search_knowledge_base",
            {"query": "help"}
        )
        super().__init__(tools, memory, logger, default_llm)
```

### 2. Register It

```python
orchestrator.register_agent(SupportAgent)
```

### 3. Update the Planner

If you're using `MockPlannerLLM`, it won't know about your new agent. Either:
- **Replace it** with a real LLM provider that generates plans dynamically, or
- **Create a custom mock** that includes your agent in the plan:

```python
class CustomPlannerLLM:
    def complete(self, prompt, context=None):
        return json.dumps([
            {"agent": "sales", "action": "execute", "payload": {"query": prompt}},
            {"agent": "marketing", "action": "execute", "payload": {"input": prompt}},
            {"agent": "support", "action": "execute", "payload": {"query": prompt}},
        ])

orchestrator.planner = LLMPlanner(orchestrator.registry, llm_provider=CustomPlannerLLM())
```

---

## Adding a New Tool

### 1. Define the Function

The function receives a `payload` dict and returns any value.

```python
def search_knowledge_base(payload):
    """Search the knowledge base for answers to a query."""
    query = payload.get("query", "")
    # In production: call a vector DB, RAG pipeline, etc.
    return {"answer": f"Here's what I found for: {query}", "confidence": 0.85}
```

### 2. Register It

```python
from proplanOrchestrator import Tool

orchestrator.register_tool(Tool(
    name="search_knowledge_base",
    schema={"query": str},
    function=search_knowledge_base,
    cost_estimate=0.005
))
```

### 3. Update Security (Optional)

If you're using a restrictive `SecurityPolicy`, add the tool to the agent's allowed list:

```python
policy = SecurityPolicy(
    allowed_tools={
        "support": ["search_knowledge_base"],
        "sales": ["find_leads_tool"],
    }
)
```

---

## Creating a Real LLM Provider

Replace the mocks with a real LLM (e.g., Anthropic Claude) by implementing the `LLMProvider` protocol.

### For Agents

The agent LLM must return a JSON string with `tool` and `payload` keys:

```python
from anthropic import Anthropic

class AnthropicAgentLLM:
    """Uses Anthropic Claude to decide which tool to call."""

    def __init__(self, api_key, model="claude-sonnet-4-20250514", available_tools=None):
        self.client = Anthropic(api_key=api_key)
        self.model = model
        self.available_tools = available_tools or []

    def complete(self, prompt, context=None):
        system = (
            f"You are an AI agent. Available tools: {self.available_tools}. "
            "Respond with JSON only: {\"tool\": \"<name>\", \"payload\": {<args>}}"
        )

        response = self.client.messages.create(
            model=self.model,
            max_tokens=1024,
            system=system,
            messages=[{"role": "user", "content": prompt}],
        )

        return response.content[0].text
```

**Inject it:**

```python
agent_llm = AnthropicAgentLLM(api_key, available_tools=["find_leads_tool", "score_lead_tool"])
orchestrator.register_agent(SalesAgent, llm_provider=agent_llm)
```

### For the Planner

The planner LLM must return a JSON array of `{agent, action, payload}` objects:

```python
class AnthropicPlannerLLM:
    """Uses Anthropic Claude to generate multi-agent task plans."""

    def __init__(self, api_key, model="claude-sonnet-4-20250514", available_agents=None):
        self.client = Anthropic(api_key=api_key)
        self.model = model
        self.available_agents = available_agents or []

    def complete(self, prompt, context=None):
        system = (
            f"You are a task planner. Available agents: {self.available_agents}. "
            "Break the request into steps. Respond with a JSON object: "
            "{\"plan\": [{\"agent\": \"<name>\", \"action\": \"execute\", \"payload\": {<args>}}]}"
        )

        memory_context = ""
        if context and context.get("memory"):
            memory_context = f"\n\nPrevious results: {json.dumps(context['memory'])}"

        response = self.client.messages.create(
            model=self.model,
            max_tokens=1024,
            system=system,
            messages=[{"role": "user", "content": prompt + memory_context}],
        )

        return response.content[0].text
```

**Inject it:**

```python
planner_llm = AnthropicPlannerLLM(api_key, available_agents=["sales", "marketing", "support"])
orchestrator.planner = LLMPlanner(orchestrator.registry, llm_provider=planner_llm)
```

---

## Customizing the Evaluator

Subclass `Evaluator` to implement custom success criteria:

```python
from proplanOrchestrator import Evaluator, Goal, TaskResult

class StrictEvaluator(Evaluator):
    """Requires all tasks to succeed AND return data with a minimum confidence score."""

    def evaluate(self, goal, batch_results):
        if not batch_results:
            return "continue"

        for r in batch_results:
            if not r.success:
                return "continue"
            if isinstance(r.data, dict) and r.data.get("confidence", 1.0) < 0.8:
                return "continue"

        return "complete"

# Inject into orchestrator
orchestrator.evaluator = StrictEvaluator()
```

---

## Writing Tests

All tests live in `test_orchestrator.py` and use Python's built-in `unittest`.

### Conventions

1. **One test class per system** — `TestEvaluator`, `TestRetryLoop`, `TestSecurityLayer`, etc.
2. **Descriptive docstrings** — Each test method has a one-line docstring explaining what it validates.
3. **Self-contained setup** — Each test creates its own `Orchestrator` to avoid shared state.

### Running Tests

```bash
# All tests
python -m unittest test_orchestrator -v

# Single class
python -m unittest test_orchestrator.TestSecurityLayer -v

# Single test
python -m unittest test_orchestrator.TestEvaluator.test_all_success_complete -v
```

### Adding a Test

```python
class TestSupportAgent(unittest.TestCase):

    def test_support_agent_uses_knowledge_base(self):
        """SupportAgent should call search_knowledge_base by default."""
        orchestrator = Orchestrator()
        orchestrator.register_tool(Tool(
            "search_knowledge_base", {"query": str},
            lambda p: {"answer": "found it"}, cost_estimate=0.005
        ))
        orchestrator.register_agent(SupportAgent)

        task = Task(id="sup-1", agent="support", action="execute", payload={"query": "help"})
        result = orchestrator.execute_task(task)

        self.assertTrue(result.success)
        self.assertEqual(result.data["answer"], "found it")
```

---

## Project Roadmap

### Launch (v2 — shipped)

| Item | Status |
|------|--------|
| FastAPI routes (`POST /agent/run`, `GET /leads`, `GET /campaigns`, `GET /runs`) | Completed |
| Supabase integration (structured memory, lead dedup, run history) | Completed |
| Async dispatch via FastAPI `BackgroundTasks` + in-memory run store | Completed |
| React 19 + TypeScript frontend (Mission, Leads, Campaigns, History, Profile) | Completed |
| Sales, Marketing, Support, Ops agents with Anthropic Claude | Completed |
| Real LLM providers (`AnthropicPlannerProvider`, `AnthropicAgentProvider`) | Completed |
| Persistence instrumentation (structured errors + amber DIAGNOSTICS panel) | Completed |
| Honest completion banner (success vs partial, with task counts) | Completed |
| CSV export for leads and campaigns (honors min_score filter) | Completed |
| Slack integration (per-user incoming webhook + SEND TO SLACK) | Completed |

### Post-launch (v3 — planned)

| Item | Why it's queued |
|------|-----------------|
| HubSpot integration (Private App token, contact push) | CRM field-mapping and error classes deserve their own iteration — CSV export is the v2 escape path. |
| Recurring missions ("send 5 new leads every morning") | Needs a real scheduler (cron/queue), idempotency keys, delivery dedup. Not a weekend build. |
| Personalized mission template generated from PROFILE | Proves silent-context-injection; small but needs a read-through of how agents consume the profile. |
| Streaming step list (replace polling spinner with live task ticks) | UX upgrade — depends on the run-status endpoint emitting intermediate events. |
| Mission Receipt (shareable URL per run) | Privacy review needed before lead lists are exposable via public URLs. |
| Confidence thresholds on agent output (⚠ for low-confidence results) | Requires agents to emit honest confidence scores — current outputs aren't reliable enough to gate on. |
