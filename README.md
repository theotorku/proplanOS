# ProPlan Agent Orchestrator

> A production-grade AI Agent Operating System that enables local businesses to automate sales, marketing, customer service, and operations.

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────┐
│                  User Request               │
└───────────────────┬─────────────────────────┘
                    ▼
┌─────────────────────────────────────────────┐
│              Orchestrator                   │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐ │
│  │ Planner  │→ │ Dispatch │→ │ Evaluator │ │
│  └──────────┘  └──────────┘  └───────────┘ │
│       ▲              │              │       │
│       │         ┌────▼────┐         │       │
│       │         │ Security│         │       │
│       │         │  Layer  │         │       │
│       │         └────┬────┘         │       │
│       └──────────────┼──────────────┘       │
└──────────────────────┼──────────────────────┘
                       ▼
     ┌─────────────────────────────────────┐
     │          Agent Registry             │
     │  ┌───────────┐  ┌────────────────┐  │
     │  │SalesAgent │  │MarketingAgent  │  │
     │  └─────┬─────┘  └───────┬────────┘  │
     └────────┼────────────────┼───────────┘
              ▼                ▼
     ┌─────────────────────────────────────┐
     │          Tool Registry              │
     │  ┌──────────────┐ ┌──────────────┐  │
     │  │find_leads    │ │generate_copy │  │
     │  └──────────────┘ └──────────────┘  │
     └─────────────────────────────────────┘
              ▼                ▼
     ┌─────────────────────────────────────┐
     │     Observability Layer             │
     │  ┌────────┐  ┌──────────────────┐   │
     │  │ Logger │  │  Cost Tracker    │   │
     │  └────────┘  └──────────────────┘   │
     └─────────────────────────────────────┘
```

---

## 🚀 Quick Start

### Prerequisites

- Python 3.10+

### Run the Orchestrator

```bash
python proplanOrchestrator.py
```

This executes the built-in example: the **SalesAgent** finds leads and the **MarketingAgent** generates ad copy.

### Run Tests

```bash
python -m unittest test_orchestrator -v
python -m unittest test_api -v
```

### Run the API Server

```bash
uvicorn api:app --reload
```

The API will be available at `http://localhost:8000`. Interactive docs at `http://localhost:8000/docs`.

**Quick smoke test:**

```bash
# Health check
curl http://localhost:8000/health

# Run the orchestrator
curl -X POST http://localhost:8000/agent/run \
  -H "Content-Type: application/json" \
  -d '{"user_id": "user-1", "request": "Find leads and generate copy"}'

# List leads (auto-stored from agent run)
curl http://localhost:8000/leads

# Create a campaign
curl -X POST http://localhost:8000/campaigns \
  -H "Content-Type: application/json" \
  -d '{"name": "Spring Sale", "status": "active"}'
```

---

## 📦 Project Structure

```
Proplan_Operating_System/
├── proplanOrchestrator.py         # Core orchestrator (agents, tools, security, memory)
├── api.py                         # FastAPI HTTP layer
├── test_orchestrator.py           # 13 unit tests for the orchestrator
├── test_api.py                    # 11 API endpoint tests
├── Proplan_Agent_Architecture.md  # Full architecture spec
├── README.md                      # ← You are here
├── API_REFERENCE.md               # Class & method reference
└── DEVELOPMENT.md                 # How to extend the system
```

---

## 🧩 Core Concepts

### Orchestrator

The central brain. It manages the **plan → dispatch → evaluate** loop:

1. **Plan** — The `LLMPlanner` breaks a user request into a list of `Task` objects.
2. **Dispatch** — Each task is routed to the correct agent via the `AgentRegistry`.
3. **Evaluate** — The `Evaluator` checks if the goal was met using the current batch of results.
4. **Repeat or stop** — If the goal is not met and limits (steps, failures, budget) aren't reached, loop again.

### Agents

Specialized workers that receive tasks and decide which tool to call. Each agent uses an `LLMProvider` to make decisions.

| Agent | Default Tool | Purpose |
|-------|-------------|---------|
| `SalesAgent` | `find_leads_tool` | Lead scraping, scoring, outreach |
| `MarketingAgent` | `generate_copy_tool` | Ad copy, campaign creation |

### Tools

Registered functions that agents can call. Each tool has a name, input schema, a callable function, and a cost estimate.

### Security Layer

Enforces three constraints before any tool execution:

| Check | What It Does |
|-------|-------------|
| **Permissions** | `can_use(agent, tool)` — Is this agent allowed to use this tool? |
| **Rate Limiting** | `check_rate_limit(agent)` — Has this agent exceeded its call quota? |
| **Budget** | `check_budget()` — Is the total cost still within the budget limit? |

### LLM Providers

A `Protocol`-based abstraction for swapping LLM backends. The system ships with mock providers (`MockAgentLLM`, `MockPlannerLLM`) and can be extended with real providers. The system ships with Anthropic (Claude) as the default LLM provider.

---

## 📖 Example Usage

```python
from proplanOrchestrator import (
    Orchestrator, Tool, SalesAgent, MarketingAgent,
    SecurityPolicy, MockAgentLLM
)

# 1. Create orchestrator (with optional security policy)
policy = SecurityPolicy(
    allowed_tools={"sales": ["find_leads_tool"]},
    rate_limits={"sales": 10},
    budget_limit=5.0
)
orchestrator = Orchestrator(security_policy=policy)

# 2. Register tools
orchestrator.register_tool(Tool(
    name="find_leads_tool",
    schema={"query": str},
    function=lambda p: [{"name": "Lead A", "score": 90}],
    cost_estimate=0.02
))

orchestrator.register_tool(Tool(
    name="generate_copy_tool",
    schema={"input": str},
    function=lambda p: "Optimized ad copy",
    cost_estimate=0.01
))

# 3. Register agents (optionally inject custom LLM providers)
orchestrator.register_agent(SalesAgent)
orchestrator.register_agent(MarketingAgent)

# 4. Run
response = orchestrator.run("Find leads and generate marketing copy")
print(response["status"])        # "completed"
print(response["total_cost"])    # 0.03
```

---

## 🔒 Security Configuration

```python
# Restrict which tools each agent can access
policy = SecurityPolicy(
    allowed_tools={
        "sales": ["find_leads_tool"],           # sales can only find leads
        "marketing": ["generate_copy_tool"],    # marketing can only generate copy
    },
    rate_limits={
        "sales": 100,       # max 100 tool calls per run
        "marketing": 50,    # max 50 tool calls per run
    },
    budget_limit=10.0       # halt if total cost exceeds $10
)

orchestrator = Orchestrator(security_policy=policy)
```

Use `SecurityPolicy.allow_all()` for development (no restrictions).

---

## 🧪 Testing

The test suite covers:

| Area | Tests |
|------|-------|
| Evaluator logic | 5 tests — all/any success, partial failures, empty batches |
| Retry loop | 2 tests — records once, succeeds on retry |
| LLM injection | 2 tests — custom provider, correct defaults per agent |
| Security | 3 tests — permissions, rate limits, budget |
| End-to-end | 1 test — full orchestration run |
| API — Health | 1 test — endpoint returns 200 |
| API — Agent Run | 3 tests — success, auto-stored leads, validation |
| API — Leads | 3 tests — list, post-run discovery, min_score filter |
| API — Campaigns | 4 tests — create, defaults, list, empty list |

```bash
# Run all tests
python -m unittest test_orchestrator test_api -v

# Run a specific test class
python -m unittest test_api.TestAgentRun -v
```

---

## 📄 License

Proprietary — ProPlan Systems.
