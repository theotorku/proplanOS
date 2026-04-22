# ProPlan Agent OS

> An Anthropic-native, multi-agent AI operating system for automating sales, marketing, support, and operations for local businesses.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     User Request                        │
│              (API / Frontend / CLI)                     │
└────────────────────────┬────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────┐
│                   Orchestrator                          │
│  ┌────────────┐  ┌────────────┐  ┌───────────────────┐ │
│  │  Planner   │→ │  Dispatch  │→ │    Evaluator      │ │
│  │ (Claude)   │  │            │  │ (all/any success)  │ │
│  └────────────┘  └─────┬──────┘  └───────────────────┘ │
│                    ┌────▼─────┐                         │
│                    │ Security │                         │
│                    │  Layer   │                         │
│                    └────┬─────┘                         │
└─────────────────────────┼───────────────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────┐
│                   Agent Registry                        │
│  ┌──────────┐ ┌───────────┐ ┌─────────┐ ┌──────────┐  │
│  │  Sales   │ │ Marketing │ │ Support │ │   Ops    │  │
│  │  Agent   │ │   Agent   │ │  Agent  │ │  Agent   │  │
│  └────┬─────┘ └─────┬─────┘ └────┬────┘ └────┬─────┘  │
└───────┼─────────────┼────────────┼───────────┼─────────┘
        ▼             ▼            ▼           ▼
┌─────────────────────────────────────────────────────────┐
│                   Tool Registry                         │
│  find_leads │ generate_copy │ search_kb │ schedule │ wf │
└─────────────────────────┬───────────────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────┐
│  Observability    │   Database     │   Cost Tracker     │
│  (Logger)         │  (Supabase)    │  (per-task $)      │
└─────────────────────────────────────────────────────────┘
```

---

## Tech Stack

| Layer           | Technology                                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------------------------- |
| **LLM**         | Anthropic Claude (claude-sonnet-4) via `anthropic` SDK                                                            |
| **Backend**     | Python 3.10+, FastAPI, Pydantic                                                                                   |
| **Database**    | Supabase (Postgres) with in-memory dev fallback                                                                   |
| **Async Queue** | Celery + Redis (optional)                                                                                         |
| **Frontend**    | React 19, TypeScript, Vite, Tailwind CSS (navy/gold operator console — Inter + Playfair Display + JetBrains Mono) |
| **Enrichment**  | Google Places API (optional, for `/onboard/scan`)                                                                 |

---

## Quick Start

### 1. Install dependencies

```bash
pip install -r requirements.txt
```

### 2. Configure environment (optional)

```bash
cp .env.example .env
# Edit .env with your keys
```

Without env vars, the system runs in **dev mode**: mock LLMs + in-memory database.

### 3. Run the orchestrator (CLI)

```bash
python proplanOrchestrator.py
```

### 4. Run the API server

```bash
uvicorn api:app --reload
```

API at `http://localhost:8000` | Docs at `http://localhost:8000/docs`

### 5. Run the frontend

```bash
cd frontend && npm install && npm run dev
```

Frontend at `http://localhost:5173`

### 6. Run tests

```bash
python -m unittest test_orchestrator test_api -v
```

---

## Project Structure

```
proplanOS/
├── proplanOrchestrator.py    # Core engine: agents, tools, security, memory, evaluator
├── api.py                    # FastAPI HTTP layer (sync + async endpoints)
├── llm.py                    # Anthropic Claude LLM providers (Planner + Agent)
├── database.py               # Database abstraction (Supabase + in-memory fallback)
├── tasks.py                  # Celery background worker for async runs
├── test_orchestrator.py      # 13 unit tests for the orchestrator
├── test_api.py               # 11 API endpoint tests
├── requirements.txt          # Python dependencies
├── .env.example              # Environment variable template
├── .gitignore
│
├── frontend/                 # React 19 + TypeScript + Vite + Tailwind
│   ├── src/App.tsx           # App shell: routing, profile, leads, campaigns, history
│   ├── src/dashboard/        # Mission Control live dashboard (KPIs, fleet, pipeline, feed)
│   ├── src/onboarding/       # Concierge onboarding flow (URL scan + prefill)
│   ├── src/index.css         # Global navy/gold tokens
│   ├── package.json
│   └── ...
│
├── migrations/               # Idempotent Supabase SQL migrations (apply via SQL editor)
│
├── Proplan_Agent_Architecture.md
├── API_REFERENCE.md
├── DEVELOPMENT.md
├── USER_GUIDE.md
├── ONBOARDING.md
└── README.md
```

---

## Agents

| Agent            | Name        | Default Tool            | Purpose                             |
| ---------------- | ----------- | ----------------------- | ----------------------------------- |
| `SalesAgent`     | `sales`     | `find_leads_tool`       | Lead scraping, scoring, outreach    |
| `MarketingAgent` | `marketing` | `generate_copy_tool`    | Ad copy, campaign creation          |
| `SupportAgent`   | `support`   | `search_knowledge_base` | Knowledge retrieval, chat responses |
| `OpsAgent`       | `ops`       | `schedule_task`         | Scheduling, workflow automation     |

## Tools

| Tool                    | Schema                 | Cost   | Description                     |
| ----------------------- | ---------------------- | ------ | ------------------------------- |
| `find_leads_tool`       | `{query: str}`         | $0.02  | Returns scored leads            |
| `generate_copy_tool`    | `{input: str}`         | $0.01  | Generates optimized ad copy     |
| `search_knowledge_base` | `{query: str}`         | $0.005 | Searches KB and returns answers |
| `schedule_task`         | `{task_name: str}`     | $0.005 | Schedules a task                |
| `run_workflow`          | `{workflow_name: str}` | $0.01  | Executes an automated workflow  |

---

## API Endpoints

| Method | Path                                  | Auth    | Description                                              |
| ------ | ------------------------------------- | ------- | -------------------------------------------------------- |
| `GET`  | `/health`                             | No      | Health check                                             |
| `POST` | `/agent/run`                          | API Key | Run orchestrator (sync)                                  |
| `POST` | `/agent/run/async`                    | API Key | Queue orchestrator run (Celery)                          |
| `GET`  | `/agent/run/{task_id}`                | API Key | Poll async run status                                    |
| `GET`  | `/leads`                              | API Key | List leads (with `?min_score=` filter)                   |
| `GET`  | `/leads/export.csv`                   | API Key | Download leads as CSV (same filters)                     |
| `POST` | `/campaigns`                          | API Key | Create a campaign                                        |
| `GET`  | `/campaigns`                          | API Key | List campaigns                                           |
| `GET`  | `/campaigns/export.csv`               | API Key | Download campaigns as CSV                                |
| `GET`  | `/profile/{user_id}`                  | API Key | Fetch business profile                                   |
| `PUT`  | `/profile/{user_id}`                  | API Key | Upsert business profile                                  |
| `GET`  | `/runs`                               | API Key | List recent orchestrator runs for a user                 |
| `POST` | `/integrations/slack/{user_id}/test`  | API Key | Send a Slack webhook ping                                |
| `POST` | `/integrations/slack/{user_id}/leads` | API Key | Post a top-N lead digest to Slack                        |
| `POST` | `/onboard/scan`                       | No      | Enrich a business URL with title + Google Places signals |
| `GET`  | `/onboard/prefill/{token}`            | No      | Fetch a pilot-customer pre-seeded onboarding state       |
| `POST` | `/agent/chat/start`                   | No      | Open a chat conversation (returns conversation_id)       |
| `POST` | `/agent/chat/message`                 | No      | Stream an assistant reply (SSE: token/done/error frames) |
| `GET`  | `/agent/chat/history/{conversation_id}` | No    | Fetch message history for a conversation                 |
| `POST` | `/agent/chat/capture_lead`            | No      | Submit contact form → lead + Slack notify                |
| `POST` | `/agent/chat/book_call`               | No      | Record booking intent + return Calendly URL             |
| `POST` | `/agent/chat/escalate`                | No      | Post the transcript to Slack for human handoff           |
| `POST` | `/agent/chat/feedback`                | No      | Store thumbs up/down on an assistant message             |

**Quick smoke test:**

```bash
curl http://localhost:8000/health

curl -X POST http://localhost:8000/agent/run \
  -H "Content-Type: application/json" \
  -d '{"user_id": "user-1", "request": "Find leads and generate copy"}'

curl http://localhost:8000/leads
```

---

## Environment Variables

| Variable                | Required | Description                                                                                                               |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`     | No       | Enables real Claude LLM planning. Falls back to mock LLMs.                                                                |
| `SUPABASE_URL`          | No       | Supabase project URL. Falls back to in-memory DB.                                                                         |
| `SUPABASE_KEY`          | No       | Supabase service key.                                                                                                     |
| `API_SECRET_KEY`        | No       | Enables `X-API-Key` header auth. Skipped if not set.                                                                      |
| `ALLOWED_ORIGINS`       | No       | CORS origins (comma-separated). Defaults to `http://localhost:5173,http://127.0.0.1:5173`.                                |
| `REDIS_URL`             | No       | Redis URL for Celery async queue. Defaults to `redis://localhost:6379/0`.                                                 |
| `GOOGLE_PLACES_API_KEY` | No       | Enables richer `/onboard/scan` results (location, vertical, one recent review). Falls back to HTML-title scrape if unset. |
| `CHAT_MODEL`            | No       | Claude model for `/agent/chat/message` stream. Defaults to `claude-sonnet-4-6`.                                           |
| `CALENDLY_URL`          | No       | Scheduling link returned by `/agent/chat/book_call`. Defaults to `https://calendly.com/proplan/intro`.                    |
| `CHAT_SLACK_WEBHOOK_URL`| No       | Incoming-webhook URL for chat escalations, lead captures, and booking notifications.                                      |
| `CHAT_RATE_LIMIT_PER_CONVO` | No   | Max user messages per conversation. Defaults to `30`.                                                                     |
| `CHAT_IP_CONVOS_PER_HOUR`   | No   | Max new conversations per IP per hour. Defaults to `100`.                                                                 |
| `CHAT_COST_CAP_USD`     | No       | Per-conversation cost cap in USD (Sonnet input+output). Defaults to `0.30`.                                               |

---

## Security Layer

The `SecurityPolicy` enforces three constraints before every tool execution:

| Check             | What It Does                                                        |
| ----------------- | ------------------------------------------------------------------- |
| **Permissions**   | `can_use(agent, tool)` — Is this agent allowed to use this tool?    |
| **Rate Limiting** | `check_rate_limit(agent)` — Has this agent exceeded its call quota? |
| **Budget**        | `check_budget()` — Is the total cost within the limit?              |

```python
policy = SecurityPolicy(
    allowed_tools={
        "sales": ["find_leads_tool"],
        "marketing": ["generate_copy_tool"],
        "support": ["search_knowledge_base"],
        "ops": ["schedule_task", "run_workflow"],
    },
    rate_limits={"sales": 100, "marketing": 50},
    budget_limit=10.0
)
orchestrator = Orchestrator(security_policy=policy)
```

Use `SecurityPolicy.allow_all()` for development.

---

## LLM Provider (Anthropic Claude)

The system uses a `Protocol`-based `LLMProvider` abstraction. Two Anthropic adapters ship in `llm.py`:

- **`AnthropicPlannerProvider`** — Breaks user requests into multi-agent task plans
- **`AnthropicAgentProvider`** — Decides which tool to call for a given task

Both default to `claude-sonnet-4-20250514`. Without an `ANTHROPIC_API_KEY`, the system falls back to `MockPlannerLLM` and `MockAgentLLM`.

---

## Testing

| Area            | Tests                                                |
| --------------- | ---------------------------------------------------- |
| Evaluator logic | 5 — all/any success, partial failures, empty batches |
| Retry loop      | 2 — records once, succeeds on retry                  |
| LLM injection   | 2 — custom provider, correct defaults per agent      |
| Security        | 3 — permissions, rate limits, budget                 |
| End-to-end      | 1 — full orchestration run                           |
| API Health      | 1                                                    |
| API Agent Run   | 3 — success, auto-stored leads, validation           |
| API Leads       | 3 — list, post-run discovery, min_score filter       |
| API Campaigns   | 4 — create, defaults, list, empty list               |

```bash
python -m unittest test_orchestrator test_api -v
```

---

## License

Proprietary — ProPlan Systems.
