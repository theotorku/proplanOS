# ProplanOS — Onboarding Plan

> Get a new developer or team member from zero to running ProplanOS in under 30 minutes.

---

## Phase 1: Local Setup (10 minutes)

### 1.1 Clone the repo

```bash
git clone https://github.com/theotorku/proplanOS.git
cd proplanOS
```

### 1.2 Backend setup

```bash
python -m venv venv
source venv/bin/activate      # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

### 1.3 Verify everything works (no keys needed)

```bash
python -m unittest test_orchestrator test_api -v
```

Expected: **24 tests passing**. The system runs entirely in dev mode with mock LLMs and in-memory database when no environment variables are set.

### 1.4 Start the API

```bash
uvicorn api:app --reload
```

Open http://localhost:8000/docs — you should see the interactive Swagger UI with all 7 endpoints.

### 1.5 Run your first agent mission

```bash
curl -X POST http://localhost:8000/agent/run \
  -H "Content-Type: application/json" \
  -d '{"user_id": "onboarding-test", "request": "Find leads and generate marketing copy"}'
```

Expected response:
```json
{
  "status": "goal_met",
  "run_id": "...",
  "user_id": "onboarding-test",
  "total_cost": 0.045,
  "cost_breakdown": {"task-1": 0.02, "task-2": 0.01, ...},
  "memory": [...]
}
```

### 1.6 Check auto-discovered leads

```bash
curl http://localhost:8000/leads
```

You should see leads extracted from the agent run (e.g., `{"full_name": "Lead A", "icp_score": 90}`).

### 1.7 Frontend setup

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173 — terminal-themed mission control UI. Type a mission and hit send.

---

## Phase 2: Understand the Architecture (10 minutes)

### Core loop

```
User Request → Planner (LLM) → [Task, Task, ...] → Agents → Tools → Results → Evaluator
                                                                                    ↓
                                                                              goal_met? → done
                                                                              continue? → re-plan
```

### Key files to read (in order)

| File | What to understand |
|------|--------------------|
| `proplanOrchestrator.py` | The entire engine — agents, tools, security, memory, evaluator |
| `llm.py` | How Anthropic Claude is wired in (Planner + Agent providers) |
| `api.py` | HTTP layer — how requests flow from API to orchestrator |
| `database.py` | Storage abstraction — Supabase models, in-memory fallback |
| `tasks.py` | Async execution via Celery (optional) |

### Architecture concepts

| Concept | What it does |
|---------|-------------|
| **Orchestrator** | Central brain. Manages the plan → dispatch → evaluate loop. |
| **LLMPlanner** | Uses Claude to break a user request into a list of Tasks. |
| **Agents** (4) | SalesAgent, MarketingAgent, SupportAgent, OpsAgent. Each consults its LLM to pick a tool. |
| **Tools** (5) | find_leads, generate_copy, search_kb, schedule_task, run_workflow. Registered with Pydantic schemas. |
| **SecurityLayer** | Three gates before every tool call: permission check → rate limit → budget check. |
| **Evaluator** | Checks if the goal was met (all_success or any_success criteria). |
| **ExecutionMemory** | Stores task/result history. Last 5 entries passed as context to the LLM. |
| **CostTracker** | Tracks $ per task. Budget enforcement halts the run if exceeded. |

### How agents make decisions

```
Task arrives → Agent.call_llm(task) → LLM returns {"tool": "find_leads_tool", "payload": {"query": "NYC"}}
            → ToolRegistry.execute() → SecurityLayer.authorize() → tool function runs → result returned
```

In dev mode, `MockAgentLLM` returns a fixed tool call. In production, `AnthropicAgentProvider` calls Claude Sonnet 4.

---

## Phase 3: Connect to Production Services (10 minutes)

### 3.1 Set up environment

```bash
cp .env.example .env
```

### 3.2 Anthropic Claude (enables real LLM planning)

Get your API key from https://console.anthropic.com/settings/keys

```env
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

Restart the API. Now `/agent/run` uses Claude to generate real plans and tool-call decisions instead of mocks.

### 3.3 Supabase (enables persistent storage)

The ProplanOS Supabase project is already provisioned:
- **URL:** `https://owtrxkxeprjgokeyhnpk.supabase.co`
- **Tables:** leads, companies, agent_sessions, consultation_bookings, email_sequences, campaigns

Get the service role key from: Supabase Dashboard → Settings → API → `service_role` (not `anon`)

```env
SUPABASE_URL=https://owtrxkxeprjgokeyhnpk.supabase.co
SUPABASE_KEY=eyJhbG...your-service-role-key
```

Restart the API. Now leads, campaigns, and agent sessions persist to Postgres.

### 3.4 API Authentication (optional)

```env
API_SECRET_KEY=any-secret-string-you-choose
```

When set, all mutation endpoints require `X-API-Key: your-secret` header.

### 3.5 Verify production mode

```bash
curl http://localhost:8000/health
# Should return {"status":"healthy",...}

curl -X POST http://localhost:8000/agent/run \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-secret" \
  -d '{"user_id": "prod-test", "request": "Find construction leads in Austin TX"}'
```

With Claude connected, the planner will generate a real multi-step plan instead of the fixed mock plan.

---

## Phase 4: Production Deployment

### Backend → Railway

```bash
railway login
railway link          # Link to existing proplan-os-backend project
railway service api   # Select the api service
railway variables set ANTHROPIC_API_KEY="sk-ant-..."
railway variables set SUPABASE_URL="https://owtrxkxeprjgokeyhnpk.supabase.co"
railway variables set SUPABASE_KEY="your-service-role-key"
railway up
railway domain        # Get public URL
```

Live at: https://api-production-8a15.up.railway.app

### Frontend → Vercel

```bash
cd frontend
vercel link --yes
echo "https://api-production-8a15.up.railway.app" | vercel env add VITE_API_URL production
vercel --prod
```

### Update CORS

After getting the Vercel URL, update Railway:

```bash
railway variables set ALLOWED_ORIGINS="https://your-frontend.vercel.app,http://localhost:5173"
```

---

## Phase 5: Extending the System

### Add a new tool

```python
# 1. Define the schema
class MyToolSchema(BaseModel):
    query: str

# 2. Define the function
def my_tool(payload):
    return {"result": f"Processed: {payload['query']}"}

# 3. Register it
orchestrator.register_tool(Tool(
    name="my_tool",
    schema=MyToolSchema,
    function=my_tool,
    cost_estimate=0.01
))
```

### Add a new agent

```python
class AnalyticsAgent(BaseAgent):
    name = "analytics"

    def __init__(self, tools, memory, logger, llm_provider=None):
        default_llm = llm_provider or MockAgentLLM("my_tool", {"query": "default"})
        super().__init__(tools, memory, logger, default_llm)

# Register
orchestrator.register_agent(AnalyticsAgent)
```

### Swap the LLM provider

Any class with a `complete(prompt, context) → str` method satisfies the `LLMProvider` protocol:

```python
class MyCustomLLM:
    def complete(self, prompt, context=None):
        # Call any LLM, RAG pipeline, or rule engine
        return '{"tool": "my_tool", "payload": {"query": "custom"}}'

orchestrator.register_agent(SalesAgent, llm_provider=MyCustomLLM())
```

---

## Checklist

### Day 1 — Local
- [ ] Clone repo, install deps
- [ ] Run 24 tests (all pass)
- [ ] Start API, hit /health
- [ ] Run first agent mission via curl
- [ ] Start frontend, run a mission from the UI
- [ ] Read `proplanOrchestrator.py` (understand the loop)
- [ ] Read `llm.py` (understand Claude integration)

### Day 2 — Production
- [ ] Set ANTHROPIC_API_KEY, verify real Claude planning works
- [ ] Set SUPABASE_URL + SUPABASE_KEY, verify data persists
- [ ] Deploy backend to Railway
- [ ] Deploy frontend to Vercel
- [ ] Run an end-to-end mission on production URLs

### Day 3 — Extend
- [ ] Add a custom tool
- [ ] Add a custom agent
- [ ] Write a test for the new agent
- [ ] Review SecurityPolicy configuration
- [ ] Read DEVELOPMENT.md and API_REFERENCE.md
