# ProplanOS — User Guide

> How to use ProplanOS to automate sales, marketing, support, and operations for your business.

---

## What is ProplanOS?

ProplanOS is an AI-powered command center that runs autonomous agents on your behalf. You describe a business objective in plain English, and ProplanOS breaks it into tasks, assigns them to specialized agents, executes them, and reports back — with full cost tracking and security enforcement.

**Four agents are at your disposal:**

| Agent | What it does | Example tasks |
|-------|-------------|---------------|
| **Sales** | Finds and scores leads | "Find 20 B2B leads in Austin TX", "Score leads for ICP fit" |
| **Marketing** | Generates copy and campaigns | "Write 5 LinkedIn outreach messages", "Create Q2 launch campaign" |
| **Support** | Searches knowledge and answers questions | "Find our refund policy", "Draft a response to a billing complaint" |
| **Ops** | Schedules tasks and runs workflows | "Schedule follow-ups for this week", "Run the onboarding workflow" |

You don't choose the agents. The **Planner** reads your request and decides which agents to deploy, in what order, and with what inputs.

---

## Getting Started

### Step 1: Open ProplanOS

Navigate to the ProplanOS dashboard in your browser.

**First-time visit:** you'll be walked through **concierge onboarding** — paste your business URL, the system scans it (site title + Google Places signals), you confirm/edit the details, and your business profile is saved. Pilot customers are sent a pre-seeded link (`/onboard/prefill/{token}`) so most fields arrive pre-filled.

**Returning visit:** you land directly in **Mission Control** — a navy/gold live operations dashboard with:

| Panel | What it shows |
|-------|--------------|
| **Hero** | "Mission Control" serif headline, your company name, fleet status pill |
| **KPI strip** | Total leads · Runs today · All-time spend · Fleet status |
| **Agent Fleet** | Sales / Marketing / Support / Ops cards with per-agent run count and spend |
| **Pipeline · 14 days** | SVG bar chart of runs per day over the last two weeks |
| **Live Feed** | Last 6 runs with timestamp, status, request text, cost |
| **Top Live Lead** | Highest-ICP lead in the pipeline (score bar + HIGH/MID/LOW band) |
| **Deploy Mission** | Template quick-picks (click to pre-fill the command bar) |
| **Mission Replay** | Color-coded steps of the last completed mission |
| **Queue** | Active / idle state for queued missions |

The sidebar shows system status, the agent registry, and run stats. The terminal composer (`[MISSION]>`) stays pinned at the bottom for dispatching new missions.

### Step 2: Run Your First Mission

At the bottom of the screen, you'll see the command bar:

```
[MISSION]> Describe your mission objective...
```

Type a request in plain English. Be specific about what you want:

**Good examples:**
- "Find 20 verified B2B leads in SaaS and score each for ICP fit"
- "Generate 5 LinkedIn outreach messages for cold pipeline activation"
- "Run a full ops review and schedule follow-up tasks for the week"
- "Create a multi-touch marketing campaign for Q2 product launch"

**Less effective:**
- "Do stuff" (too vague — the planner can't generate a useful task graph)
- "Help" (no actionable objective)

Click **DEPLOY** or press **Enter** to launch the mission.

### Step 3: Watch the Execution

Once deployed, you'll see:
1. **Processing log** — Real-time status: "Initializing secure agent environment...", "Planner LLM generating task graph...", "Security layer: permissions validated..."
2. **Mission complete** — Each task shown with its agent, payload, output, and success/failure status
3. **Cost breakdown** — Per-task cost visualization with bar chart

### Step 4: Review Results

Each completed task shows:

```
01  SALES-01  EXECUTE  ✓ OK
    PAYLOAD: {"query": "find leads"}
    OUTPUT:  [{"name": "Lead A", "score": 90}]
```

- **Agent badge** — Which agent handled it (color-coded)
- **Status** — ✓ OK or ✗ FAIL
- **Retries** — If the task failed and was retried (up to 2 retries)
- **Payload** — What was sent to the tool
- **Output** — What the tool returned

At the bottom, the **Cost Breakdown** shows how much each task cost and the total run cost.

---

## Five Views

Use the tabs in the header to switch between views: **Mission · Leads · Campaigns · History · Profile**.

### Mission (default)

The live operations dashboard (see Step 1 for the full panel breakdown). Run missions, watch them execute, and track everything on one screen. While a mission is in flight, the dashboard gives way to a real-time processing log; when it completes, the task-by-task results and cost breakdown render inline. Press the PROPLAN brand in the top-left to return to the dashboard.

**Template quick-picks** appear in the Deploy Mission card — click any template to pre-fill the terminal composer with a ready-to-deploy objective.

### Leads

A database table of all leads discovered by agent runs.

| Column | What it shows |
|--------|--------------|
| NAME | Lead name |
| SCORE | ICP fit score (0-100) |
| FIT | HIGH (70+), MID (40-69), LOW (0-39) |
| SOURCE | Where the lead came from (agent, manual) |
| ID | Unique lead identifier |

**Filtering:** Use the MIN SCORE dropdown to filter leads by quality:
- ALL — show everything
- 40+ — mid-tier and above
- 70+ — high-value leads only
- 90+ — top-tier leads

**Refresh:** Click the REFRESH button to pull the latest leads from the database.

**Export CSV:** Click EXPORT CSV to download the current view as a timestamped `.csv` file. The export honors the active MIN SCORE filter and includes fields beyond what's in the table (email, phone, company, role, qualification rationale). Drop it straight into your CRM.

**Send to Slack:** If you've configured a Slack webhook in PROFILE → INTEGRATIONS, click SEND TO SLACK to post the top 10 leads (sorted by score) to your channel.

Leads are auto-populated when you run missions with the Sales agent. You don't need to add them manually.

### Campaigns

A registry of marketing campaigns.

| Column | What it shows |
|--------|--------------|
| NAME | Campaign name |
| STATUS | draft, active, paused, completed |
| CREATED | When the campaign was created |
| ID | Unique campaign identifier |

Campaigns can be created via the API (`POST /campaigns`). Future versions will allow creating campaigns directly from the UI.

**Export CSV:** The CAMPAIGNS toolbar also has an EXPORT CSV button for downloading the registry as a timestamped file.

### History

A chronological log of every orchestrator run for the signed-in user (last 20 by default). Each row shows the run ID, timestamp, status, total cost, and the request that triggered it — useful for auditing what the fleet has been doing and what it spent.

### Profile

Your business context — company name, what you do, ICP, target industries, geography, lead signals, value proposition, communication tone, and Slack webhook URL. This context is silently injected into every agent run, so agents don't need to re-learn who you are. Fill it once, then forget it.

Concierge onboarding pre-fills this tab for pilot customers; you can edit any field later.

---

## Sharing Results

### Export to CSV

Both LEADS and CAMPAIGNS have an **EXPORT CSV** button in the toolbar. The file is timestamped (`proplan-leads-YYYYMMDD-HHMMSS.csv`) and includes every stored field — not just the columns shown in the table. For LEADS, the active MIN SCORE filter applies to the export, so you can pull just the high-fit slice.

CSV imports cleanly into HubSpot, Salesforce, Close, Pipedrive, and Google Sheets.

### Slack Integration

Send a lead digest to your Slack channel with one click.

**One-time setup** (inside Slack):
1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**.
2. Pick your workspace and name it (e.g. "ProPlan").
3. Under **Incoming Webhooks**, toggle the feature on.
4. Click **Add New Webhook to Workspace**, pick the channel, and authorize.
5. Copy the webhook URL (it starts with `https://hooks.slack.com/services/...`).

**Inside ProplanOS:**
1. Open the **PROFILE** tab → scroll to **INTEGRATIONS**.
2. Paste the webhook URL into **SLACK INCOMING WEBHOOK URL**.
3. Click **SAVE PROFILE**, then **TEST** to confirm Slack receives a message.

Once that's done, every LEADS view shows a **SEND TO SLACK** button. Clicking it posts the top 10 leads from the current view (sorted by score, honoring MIN SCORE) to your channel.

> HubSpot integration is on the v3 roadmap. For now, use **EXPORT CSV** to move leads into HubSpot or any other CRM.

---

## How Missions Work (Behind the Scenes)

When you type a mission and hit DEPLOY, here's what happens:

```
1. YOUR REQUEST        "Find leads and generate marketing copy"
       ↓
2. PLANNER (Claude)    Breaks it into tasks:
                         - Task 1: sales → find_leads_tool
                         - Task 2: marketing → generate_copy_tool
                         - Task 3: support → search_knowledge_base
                         - Task 4: ops → schedule_task
       ↓
3. SECURITY CHECK      For each task:
                         ✓ Is this agent allowed to use this tool?
                         ✓ Has the agent exceeded its rate limit?
                         ✓ Is the total cost still within budget?
       ↓
4. AGENT EXECUTION     Each agent consults Claude to decide:
                         - Which tool to call
                         - What arguments to pass
                       Then executes the tool.
       ↓
5. EVALUATION          Did all tasks succeed?
                         YES → Mission complete (status: goal_met)
                         NO  → Re-plan and retry (up to 5 iterations)
       ↓
6. RESULTS             Full execution log returned to the UI:
                         - Per-task results
                         - Cost breakdown
                         - Run ID for audit trail
```

### Automatic retries

If a task fails, the system retries it up to 2 times before marking it as failed. You'll see a retry indicator (↻ 1, ↻ 2) next to failed tasks.

### Budget enforcement

Every tool has a cost estimate. The system tracks cumulative cost across all tasks in a run. If the budget limit is exceeded, the run halts immediately — no further tasks are executed.

### Security

The Security Layer enforces three rules before every tool execution:
1. **Permissions** — Each agent can only use its assigned tools
2. **Rate limits** — Maximum number of tool calls per agent per run
3. **Budget** — Global cost ceiling per run

These are not optional. They run on every single tool call, even in development mode.

---

## Tips for Effective Missions

### Be specific about scope
Instead of "find leads," try "find 20 B2B SaaS leads in the $50K-$200K ARR range in Austin TX."

### Combine multiple objectives
ProplanOS can handle multi-agent missions. "Find leads, generate outreach copy for each, and schedule follow-up calls for next week" will deploy Sales, Marketing, and Ops agents in sequence.

### Check the Leads tab after Sales missions
Every lead discovered by the Sales agent is automatically stored in the database. Switch to the Leads tab to see them, filter by score, and export.

### Use the cost breakdown
Each mission shows exactly what it cost. Use this to optimize — if a tool is consuming too much budget, adjust your request to be more targeted.

### Run missions iteratively
Start with a focused mission ("Find leads in Austin TX"), review results, then run a follow-up ("Generate outreach copy for the top 5 leads from the last run"). The system builds context over successive runs.

---

## API Access

For programmatic access, the backend API is available at your deployment URL.

### Quick reference

```bash
# Health check
curl https://your-backend-url/health

# Run a mission
curl -X POST https://your-backend-url/agent/run \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{"user_id": "user-1", "request": "Find leads in Austin TX"}'

# List leads (with score filter)
curl "https://your-backend-url/leads?min_score=70"

# Download leads as CSV (honors the same filters)
curl -OJ "https://your-backend-url/leads/export.csv?min_score=70" \
  -H "X-API-Key: your-api-key"

# Post the top 10 leads to Slack (webhook URL must be in the user's profile)
curl -X POST "https://your-backend-url/integrations/slack/user-1/leads?min_score=70" \
  -H "X-API-Key: your-api-key"

# Create a campaign
curl -X POST https://your-backend-url/campaigns \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{"name": "Q2 Launch", "status": "active"}'

# List campaigns
curl https://your-backend-url/campaigns
```

### Authentication

If `API_SECRET_KEY` is configured, include the `X-API-Key` header with every request to mutation endpoints (`POST /agent/run`, `POST /campaigns`). Read endpoints (`GET /health`, `GET /leads`, `GET /campaigns`) may also require it depending on configuration.

---

## Glossary

| Term | Definition |
|------|-----------|
| **Mission** | A natural-language business objective you submit to ProplanOS |
| **Agent** | A specialized AI worker (Sales, Marketing, Support, Ops) |
| **Tool** | A function an agent can call (find_leads, generate_copy, etc.) |
| **Task** | A single unit of work: one agent calling one tool with specific inputs |
| **Planner** | The Claude LLM that breaks your mission into a task graph |
| **Evaluator** | Checks if all tasks succeeded; decides whether to re-plan or stop |
| **ICP Score** | Ideal Customer Profile score (0-100). Higher = better fit. |
| **Run ID** | Unique identifier for each mission execution (for audit trails) |
| **Budget** | Maximum cost allowed per mission run. Enforced automatically. |
| **SecurityPolicy** | Rules governing which agents can use which tools, rate limits, and budget |

---

## Troubleshooting

**"Connection failed" when running a mission**
The frontend can't reach the backend. Check that the backend is running and the `VITE_API_URL` environment variable is set correctly.

**Mission returns but all tasks show ✗ FAIL**
This usually means the tools aren't registered or the security policy is blocking access. In development mode with mock LLMs, this shouldn't happen — contact your administrator.

**Leads tab shows "NO LEADS ON RECORD"**
Run a mission that involves the Sales agent (e.g., "Find leads in Austin TX"). Leads are auto-stored after each run.

**Cost shows $0.00**
You're running in dev mode with mock LLMs. Connect an Anthropic API key for real Claude planning with accurate cost tracking.
