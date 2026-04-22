# Chat Agent Runbook

Deploy guide for the embeddable chat agent — the floating bubble on
`proplansolutions.io` and the shareable `/chat` page.

---

## 1. What ships

**Backend (FastAPI):** 7 public endpoints under `/agent/chat/*` — start,
message (SSE stream), history, capture_lead, book_call, escalate, feedback.
Streams Claude Sonnet token-by-token, persists every conversation + message
to Supabase (or in-memory for dev), enforces per-conversation rate limits,
per-IP conversation limits, and a hard $ cost cap.

**Frontend:**

- `frontend/public/chat-widget.js` — vanilla-JS IIFE. Embed on any site.
- `frontend/src/pages/Chat.tsx` — standalone React page served at `/chat`.

Both share the same localStorage key (`proplan_chat_v1`) so a visitor who
starts in the widget and lands on `/chat` keeps the same conversation.

---

## 2. One-time setup

### 2.1 Apply the Supabase migration

```bash
# From project root, paste into Supabase SQL editor, or:
supabase db push  # if you use the Supabase CLI with this repo linked
```

The migration file is `migrations/0006_chat_agent.sql`. It is idempotent
(`create table if not exists`) — safe to re-run.

Tables added:

- `chat_conversations` — one row per visitor conversation
- `chat_messages` — one row per user or assistant turn
- `leads.source_conversation_id` — FK so captured leads link back to the transcript

### 2.2 Railway (or your backend host) env vars

Required for production:

```
ANTHROPIC_API_KEY=sk-ant-...
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_KEY=<service-role-key>
CHAT_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
CALENDLY_URL=https://calendly.com/proplan/intro
ALLOWED_ORIGINS=https://proplansolutions.io,https://www.proplansolutions.io,https://proplan.vercel.app
```

Optional overrides (defaults shown):

```
CHAT_MODEL=claude-sonnet-4-6
CHAT_RATE_LIMIT_PER_CONVO=30
CHAT_IP_CONVOS_PER_HOUR=100
CHAT_COST_CAP_USD=0.30
```

If `ANTHROPIC_API_KEY` is unset, `/agent/chat/message` returns a canned
mock stream — useful for preview deploys, broken in front of real visitors.

### 2.3 CORS allow-list

`ALLOWED_ORIGINS` **must** include every origin that will embed the widget
or hit `/chat` from a browser. Comma-separated, no trailing slash.

Minimum for launch:

```
https://proplansolutions.io,https://www.proplansolutions.io,https://proplan.vercel.app
```

Add your Vercel preview origin while testing, then remove it before launch.

### 2.4 Vercel (frontend)

- `frontend/vercel.json` already rewrites `/chat` → `/index.html` so the
  SPA can claim the route.
- Set `VITE_API_URL` in the Vercel project to the Railway backend URL so
  both the widget and the React page hit the right host.
- Redeploy after the env var change; Vite inlines it at build time.

---

## 3. Embed on proplansolutions.io

Drop this into the site `<head>` (or right before `</body>`):

```html
<script>
  window.PROPLAN_API_URL = "https://api.proplansolutions.io"; // your backend
</script>
<script src="https://proplan.vercel.app/chat-widget.js" defer></script>
```

The script self-guards against double-load (`window.__proplanChatLoaded`).
Mounts into a Shadow DOM so it cannot leak or absorb host-site styles.

UTM parameters from the current URL are captured automatically and attached
to any `capture_lead` / `book_call` submission.

---

## 4. Slack setup

1. In Slack, create a new incoming webhook pointed at the channel that
   should see chat alerts (e.g. `#proplan-chat`).
2. Paste the URL into `CHAT_SLACK_WEBHOOK_URL`.

You will get posts for:

- **Lead captured** — visitor fills the contact form
- **Call booked** — visitor hits "Book a call"
- **Escalation** — visitor asks for a human, transcript included

This is separate from the per-user Slack webhook on `business_profiles`
(that one is for the orchestrator's lead digests). Keep them distinct so
chat traffic doesn't spam individual pilot customers' channels.

---

## 5. Calendly

Set `CALENDLY_URL` to the booking link. `/agent/chat/book_call` returns
it in the JSON response; the UI opens it in a new tab. No API keys, no
webhook — Calendly itself handles the actual scheduling UX.

To swap providers (Cal.com, SavvyCal, etc.), just change the URL.

---

## 6. Verifying after deploy

```bash
# 1. Health
curl https://api.proplansolutions.io/health

# 2. Start a conversation
curl -X POST https://api.proplansolutions.io/agent/chat/start \
  -H "Content-Type: application/json" \
  -d '{"page_url":"https://proplansolutions.io"}'
# → {"conversation_id":"...","messages":[...]}

# 3. Stream a reply (look for data: frames)
curl -N -X POST https://api.proplansolutions.io/agent/chat/message \
  -H "Content-Type: application/json" \
  -d '{"conversation_id":"<id>","message":"What does ProPlan do?"}'
```

Browser smoke test:

1. Visit `https://proplan.vercel.app/chat` → the shareable page loads.
2. Ask a question → tokens should stream in (not land as one block).
3. Click **Book a call** → Calendly opens, Slack gets the ping.
4. Click **Talk to a human** → transcript shows up in Slack.

---

## 7. Guardrails

- **Per-conversation cap** — `CHAT_RATE_LIMIT_PER_CONVO` user messages, then
  the endpoint returns `429`.
- **Per-IP cap** — `CHAT_IP_CONVOS_PER_HOUR` new conversations per hour.
- **Cost cap** — each conversation tracks cumulative token spend; once it
  crosses `CHAT_COST_CAP_USD` the stream refuses further replies.
- **Prompt-injection mitigation** — every user message is wrapped in
  `<user_input>...</user_input>` before it hits the model, and the system
  prompt tells Claude to treat that block as untrusted content.

---

## 8. Ship order (for reference)

1. `migrations/0006_chat_agent.sql` applied to Supabase
2. Railway env vars set, backend redeployed, `/health` green
3. `ALLOWED_ORIGINS` includes the embedding host
4. Vercel redeployed (serves `/chat` and `/chat-widget.js`)
5. Embed snippet added to proplansolutions.io `<head>`
6. Smoke test all three CTAs (lead / book / escalate) end-to-end
