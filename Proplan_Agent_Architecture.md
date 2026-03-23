# ProPlan Agent Architecture — Master Documentation

---

# 1. VISION DOCUMENT (WHY)

## Mission

Build a production-grade AI Agent Operating System that enables local businesses to automate sales, marketing, customer service, and operations.

## Core Belief

Agents are infrastructure, not features.

## Problem

* Businesses lack automation
* AI tools are fragmented
* Current agents are unsafe and unreliable

## Solution

A modular, secure, multi-agent platform that orchestrates specialized AI workers.

## Long-Term Vision

Become the default AI infrastructure layer for service-based businesses.

---

# 2. SYSTEM OVERVIEW (WHAT)

## Architecture Layers

1. **Frontend** — React + Vite single-page app (terminal-aesthetic UI)
2. **API Gateway** — FastAPI with async dispatch and CORS
3. **Agent Orchestrator** — Plan → dispatch → evaluate loop with LLM-powered planning
4. **Multi-Agent Layer** — Sales, Marketing, Support, Ops agents with injected LLM providers
5. **Tool Layer** — LLM-powered tools with mock fallbacks (find leads, generate copy, etc.)
6. **Memory Layer** — ExecutionMemory for task history, BusinessProfile for context injection
7. **Security Layer** — Per-agent permissions, rate limits, budget enforcement
8. **Infrastructure Layer** — Supabase (production DB), InMemoryDatabase (dev), optional Celery

---

# 3. TECH STACK

## Backend

* Python 3.13+
* FastAPI (async dispatch with BackgroundTasks)
* Pydantic v2 (request/response validation)
* Anthropic SDK (Claude Sonnet for planning/routing, Claude Haiku for tool calls)

## Frontend

* React 18 (Vite)
* TypeScript
* Custom terminal-aesthetic UI (IBM Plex Mono, CSS variables, scanlines)
* Lucide React (icons)

## Database

* Supabase (Postgres) — production
* InMemoryDatabase — development/testing fallback
* Tables: leads, campaigns, agent_sessions, business_profiles

## Infrastructure

* Optional: Redis + Celery (async queue)
* FastAPI BackgroundTasks (default async execution)

## Deployment

* Vercel (frontend)
* Railway (backend)

---

# 4. AGENT ORCHESTRATOR SPEC

## Purpose

Central brain that manages all agents through a plan-dispatch-evaluate loop.

## Responsibilities

* Interpret user intent via LLM planner
* Break tasks into steps (Task objects)
* Assign tasks to specialized agents
* Retry failed tasks (iterative, max 2 retries)
* Evaluate batch results against goal criteria
* Enforce security policy (permissions, rate limits, budget)
* Inject business context into planning

## Interface

Input:
```python
orchestrator.run(
    request: str,                          # Natural-language mission
    business_context: Optional[str] = None # Company profile for context injection
)
```

Output:
```python
{
    "status": "goal_met" | "max_steps_reached" | "max_failures_reached" | "budget_exceeded",
    "run_id": str,
    "total_cost": float,
    "cost_breakdown": Dict[str, float],
    "logs": List[Dict],
    "memory": List[Dict]   # Full execution history (all tasks)
}
```

## Core Loop

1. Parse request (prepend business context if provided)
2. Generate task plan via LLMPlanner
3. Dispatch tasks to registered agents
4. Execute tools with security checks
5. Evaluate batch results against goal
6. Replan if needed (up to max_steps)
7. Return aggregated results

---

# 5. MULTI-AGENT SPEC

## Agent Template

Each agent extends `BaseAgent` and receives an injected `LLMProvider`:

```python
class BaseAgent:
    def __init__(self, name, tools, memory, logger, llm_provider=None):
        ...

    def call_llm(self, task: Task) -> Dict[str, Any]:
        """Query LLM for tool-call decision (with code fence stripping)."""

    def run(self, task: Task) -> TaskResult:
        """Execute: LLM decision → security check → tool execution → result."""
```

## Agents

### Sales Agent
* Default tool: `find_leads_tool`
* LLM-powered B2B lead research and ICP scoring

### Marketing Agent
* Default tool: `generate_copy_tool`
* LLM-powered copywriting (email, LinkedIn, ads)

### Support Agent
* Default tool: `search_knowledge_base`
* LLM-powered knowledge queries with confidence scoring

### Ops Agent
* Default tools: `schedule_task`, `run_workflow`
* LLM-powered scheduling and workflow automation

---

# 6. TOOL REGISTRY SPEC

## Purpose

Standardized way for agents to execute actions with validation and cost tracking.

## Tool Schema

```python
Tool(
    name: str,
    schema: Dict[str, type],   # Pydantic-validated payload schema
    function: Callable,
    cost_estimate: float = 0.01
)
```

## Registered Tools

| Tool | Cost | Description |
|------|------|-------------|
| `find_leads_tool` | $0.02 | LLM-powered lead research with ICP scoring |
| `generate_copy_tool` | $0.01 | LLM-powered B2B copywriting |
| `search_knowledge_base` | $0.005 | LLM-powered support/knowledge queries |
| `schedule_task` | $0.005 | LLM-powered task scheduling |
| `run_workflow` | $0.01 | LLM-powered workflow execution |

All tools call `claude-haiku-4-5-20251001` when `ANTHROPIC_API_KEY` is set, with hardcoded mock fallbacks when it is not. LLM responses are stripped of markdown code fences before JSON parsing.

---

# 7. MEMORY SYSTEM SPEC

## Types of Memory

### 1. Execution Memory
* Full task/result history per run
* `get_context()` returns last 5 entries (for LLM context windows)
* `history` contains all entries (used in run results and lead extraction)

### 2. Business Profile Memory
* Per-user company context (company name, ICP, target industries, etc.)
* Injected into every orchestrator run as `[BUSINESS CONTEXT]` block
* Persisted via API (`PUT /profile/{user_id}`) with localStorage fallback

### 3. Structured Data
* Leads — extracted from tool results and persisted to Supabase
* Campaigns — created via API
* Agent Sessions — run logs with cost, duration, status

---

# 8. DATABASE SCHEMA

## Tables

### leads
* id, full_name, email, phone, company_name, role
* inquiry_type, message, employee_count, monthly_lead_volume
* project_types, avg_project_budget, current_location
* icp_score (0-100), qualification_status, qualification_rationale
* qualification_factors, source, created_at, updated_at

### campaigns
* id, name, status, created_at, updated_at

### agent_sessions
* id, run_id, user_id, lead_id, agent_type
* status ("completed" | "failed"), input_data, output_data
* reasoning_trace, cost_usd, input_tokens, output_tokens
* model_used, duration_ms, steps_taken, started_at, completed_at

### business_profiles
* id, user_id (unique), company_name, what_we_do
* icp, target_industries, company_size, geography
* lead_signals, value_proposition, tone
* created_at, updated_at

---

# 9. SECURITY LAYER SPEC

## Goals

* Prevent misuse via per-agent tool permissions
* Control costs via budget enforcement
* Ensure safe execution via rate limiting

## Features

* **Tool permissions** — `allowed_tools: {agent_name: [tool_names]}`
* **Rate limiting** — `rate_limits: {agent_name: max_calls}`
* **Budget enforcement** — `budget_limit: float` (total cost cap)
* **Input validation** — Pydantic schema validation on all tool payloads
* **Audit logs** — Structured logging of every agent action

## Authorization Flow

```
Agent request → Check budget → Check permission → Check rate limit → Execute → Log
```

`SecurityPolicy.allow_all()` factory provides a wide-open dev policy.

---

# 10. API DESIGN

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/agent/run` | Dispatch async orchestrator run (returns `{status, run_id}`) |
| `GET` | `/agent/run/status/{run_id}` | Poll for run result |
| `POST` | `/agent/run/async` | Queue via Celery (if configured) |
| `GET` | `/agent/run/{task_id}` | Poll Celery task status |
| `GET` | `/leads` | List leads (optional `min_score`, `limit`, `offset`) |
| `POST` | `/campaigns` | Create campaign |
| `GET` | `/campaigns` | List campaigns |
| `GET` | `/profile/{user_id}` | Get business profile |
| `PUT` | `/profile/{user_id}` | Create/update business profile |
| `GET` | `/runs` | List mission history for a user |
| `GET` | `/health` | Health check |

## Auth

* `X-API-Key` header validated against `API_SECRET_KEY` env var
* Skipped in development when `API_SECRET_KEY` is not set

## CORS

* Origins restricted via `ALLOWED_ORIGINS` env var (comma-separated)
* Defaults to `http://localhost:5173`

---

# 11. FRONTEND SPEC

## Views (Single-Page, Tab-Switched)

* **Mission** — Command input, processing log animation, task result display
* **Leads** — Data table with ICP scores, fit badges, score filter
* **Campaigns** — Data table with status badges
* **History** — Past mission runs with status, cost, timestamps
* **Profile** — Business profile form (Identity, Target Market, Lead Intelligence)

## Key Features

* Persistent user identity (UUID in localStorage)
* Business profile with API persistence + localStorage fallback
* Async mission execution with 2s polling and processing log animation
* Mission templates for common use cases
* Profile completeness indicator (amber dot on tab)

---

# 12. EVENT BUS / TASK QUEUE

## Implementation

* **Primary**: FastAPI `BackgroundTasks` with in-memory run store (thread-safe, TTL eviction)
* **Optional**: Redis + Celery (`POST /agent/run/async`) for distributed workers

## Pattern

```
POST /agent/run → dispatch background task → return run_id
Client polls GET /agent/run/status/{run_id} every 2s
Background task: orchestrator.run() → persist leads → log session → write result
```

Run store entries are evicted after 1 hour (only finished entries; running entries are exempt).

---

# 13. DEPLOYMENT PIPELINE

## Steps

1. Frontend: `npm run build` → deploy to Vercel
2. Backend: deploy to Railway with env vars
3. Database: Supabase project with schema migrations
4. Environment: `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_KEY`, `API_SECRET_KEY`, `ALLOWED_ORIGINS`

---

# 14. TESTING STRATEGY

## Unit Tests (`test_orchestrator.py`)

* Evaluator batch-based evaluation (all_success, any_success, empty)
* Iterative retry loop (single memory entry, flakey recovery)
* LLM provider injection (swappable behavior)
* Security enforcement (permissions, rate limits, budget)
* Full end-to-end run

## API Tests (`test_api.py`)

* Health check
* Async agent dispatch + polling
* Lead persistence after run
* Lead filtering with seeded data
* Campaign CRUD
* Input validation (422 on missing fields)

---

# 15. FUTURE EXPANSION

* MCP compatibility
* Plugin marketplace
* Industry-specific templates
* Real-time WebSocket updates (replace polling)
* Multi-user auth (Clerk / Supabase Auth)

---

# END OF DOCUMENT
