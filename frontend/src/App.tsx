import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Terminal, Activity, Shield, Zap, CheckCircle, XCircle, RefreshCw, Users, Megaphone, Settings, Save, Download, MessageSquare, AlertTriangle } from 'lucide-react';

const API_BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8000';
const API_KEY = import.meta.env.VITE_API_KEY ?? '';

function apiHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  if (API_KEY) h['X-API-Key'] = API_KEY;
  return h;
}

// ─── Types ──────────────────────────────────────────────────────
type View = 'mission' | 'leads' | 'campaigns' | 'profile' | 'history';

type RunHistory = {
  id: string;
  run_id: string | null;
  status: string;
  input_data: { request?: string; user_id?: string } | null;
  output_data: { total_cost?: number; status?: string } | null;
  cost_usd: number | null;
  started_at: string | null;
};

const USER_ID_KEY = 'proplan_user_id';

function getOrCreateUserId(): string {
  const existing = localStorage.getItem(USER_ID_KEY);
  if (existing) return existing;
  const id = `user-${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2, 18)}`;
  localStorage.setItem(USER_ID_KEY, id);
  return id;
}

type BusinessProfile = {
  company_name: string;
  what_we_do: string;
  icp: string;
  target_industries: string;
  company_size: string;
  geography: string;
  lead_signals: string;
  value_proposition: string;
  tone: string;
  slack_webhook_url: string;
};

const EMPTY_PROFILE: BusinessProfile = {
  company_name: '',
  what_we_do: '',
  icp: '',
  target_industries: '',
  company_size: '',
  geography: '',
  lead_signals: '',
  value_proposition: '',
  tone: 'professional',
  slack_webhook_url: '',
};

const PROFILE_KEY = 'proplan_business_profile';

function loadProfile(): BusinessProfile {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    return raw ? { ...EMPTY_PROFILE, ...JSON.parse(raw) } : EMPTY_PROFILE;
  } catch {
    return EMPTY_PROFILE;
  }
}

function profileToContext(p: BusinessProfile): string | null {
  if (!p.company_name && !p.what_we_do && !p.icp) return null;
  const lines: string[] = [];
  if (p.company_name)       lines.push(`Company: ${p.company_name}`);
  if (p.what_we_do)         lines.push(`What we do: ${p.what_we_do}`);
  if (p.icp)                lines.push(`Ideal Customer Profile: ${p.icp}`);
  if (p.target_industries)  lines.push(`Target industries: ${p.target_industries}`);
  if (p.company_size)       lines.push(`Target company size: ${p.company_size}`);
  if (p.geography)          lines.push(`Geography: ${p.geography}`);
  if (p.lead_signals)       lines.push(`Lead qualification signals: ${p.lead_signals}`);
  if (p.value_proposition)  lines.push(`Value proposition: ${p.value_proposition}`);
  if (p.tone)               lines.push(`Communication tone: ${p.tone}`);
  return lines.join('\n');
}

function profileComplete(p: BusinessProfile): boolean {
  return !!(p.company_name && p.what_we_do && p.icp);
}

type TaskMemory = {
  task: {
    id: string;
    agent: string;
    action: string;
    payload: Record<string, unknown>;
    retries: number;
  };
  result: {
    task_id: string;
    success: boolean;
    data: unknown;
    error: string | null;
  };
};

type PersistenceError = {
  target: 'lead' | 'session' | string;
  index?: number;
  error_type: string;
  message: string;
};

type PersistenceInfo = {
  backend: 'supabase' | 'memory' | string;
  leads_extracted: number;
  leads_saved: number;
  session_logged: boolean;
  errors: PersistenceError[];
};

type OrchestratorResponse = {
  status: string;
  run_id: string;
  user_id: string;
  total_cost: number;
  cost_breakdown: Record<string, number>;
  memory: TaskMemory[];
  persistence?: PersistenceInfo;
};

type Lead = {
  id: string;
  full_name: string;
  icp_score: number | null;
  source: string;
};

type Campaign = {
  id: string;
  name: string;
  status: string;
  created_at: string | null;
};

// ─── Agent Registry ──────────────────────────────────────────────
const AGENTS: Record<string, { label: string; color: string; code: string }> = {
  sales:     { label: 'SALES-01', color: '#ff6b35', code: 'SL' },
  marketing: { label: 'MKTG-02',  color: '#ff3cac', code: 'MK' },
  support:   { label: 'SUPP-03',  color: '#00d4ff', code: 'SP' },
  ops:       { label: 'OPS-04',   color: '#ffd60a', code: 'OP' },
};

function getAgent(name: string) {
  return AGENTS[name.toLowerCase()] ?? { label: name.toUpperCase(), color: '#888', code: name.slice(0, 2).toUpperCase() };
}

// ─── Processing Log Sequence ──────────────────────────────────────
const PROC_LINES = [
  '> Initializing secure agent environment...',
  '> Injecting business context into planner...',
  '> Anthropic Claude generating task graph...',
  '> Security layer: permissions validated...',
  '> Rate limit check — OK',
  '> Budget gate — OK',
  '> Dispatching to registered agent pool...',
  '> Agents executing with real AI — please wait...',
  '> Polling for results every 2s...',
];

// ─── Mission Templates ───────────────────────────────────────────
const TEMPLATES = [
  'Find 20 verified B2B leads in SaaS and score each for ICP fit',
  'Generate 5 LinkedIn outreach messages for cold pipeline activation',
  'Run a full ops review and schedule follow-up tasks for the week',
  'Create a multi-touch marketing campaign for Q2 product launch',
];

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function scoreColor(score: number): string {
  if (score >= 70) return 'var(--accent)';
  if (score >= 40) return 'var(--warn)';
  return 'var(--error)';
}

function statusColor(status: string): string {
  switch (status.toLowerCase()) {
    case 'active':    return 'var(--success)';
    case 'draft':     return 'var(--muted)';
    case 'paused':    return 'var(--warn)';
    case 'completed': return 'var(--accent)';
    default:          return 'var(--muted)';
  }
}

// goal_met = success; everything else terminal but non-success = partial.
type RunOutcome = 'success' | 'partial';

function runOutcome(status: string): RunOutcome {
  return status === 'goal_met' ? 'success' : 'partial';
}

function runStatusLabel(status: string): string {
  switch (status) {
    case 'goal_met':            return 'MISSION COMPLETE';
    case 'max_failures_reached': return 'MISSION STOPPED — MAX FAILURES';
    case 'max_steps_reached':    return 'MISSION STOPPED — MAX STEPS';
    case 'budget_exceeded':      return 'MISSION STOPPED — BUDGET EXCEEDED';
    default:                     return `MISSION STOPPED — ${status.toUpperCase()}`;
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: '2-digit', year: 'numeric',
  });
}

// ─── Component ───────────────────────────────────────────────────
export default function App() {
  // View
  const [view, setView] = useState<View>('mission');

  // User identity (persistent across sessions)
  const [userId] = useState<string>(getOrCreateUserId);

  // Profile state
  const [profile, setProfile]           = useState<BusinessProfile>(loadProfile);
  const [profileDraft, setProfileDraft] = useState<BusinessProfile>(loadProfile);
  const [profileSaved, setProfileSaved] = useState(false);
  const [profileSaveError, setProfileSaveError] = useState<string | null>(null);

  // History state
  const [runs, setRuns]               = useState<RunHistory[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError]     = useState<string | null>(null);

  // Mission state
  const [prompt, setPrompt]       = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [response, setResponse]   = useState<OrchestratorResponse | null>(null);
  const [missionError, setMissionError] = useState<string | null>(null);
  const [procLines, setProcLines] = useState<string[]>([]);
  const [procIdx, setProcIdx]     = useState(0);

  // Leads state
  const [leads, setLeads]           = useState<Lead[]>([]);
  const [leadsLoading, setLeadsLoading] = useState(false);
  const [leadsError, setLeadsError] = useState<string | null>(null);
  const [minScore, setMinScore]     = useState(0);

  // Campaigns state
  const [campaigns, setCampaigns]           = useState<Campaign[]>([]);
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [campaignsError, setCampaignsError] = useState<string | null>(null);

  // System health
  const [systemOnline, setSystemOnline] = useState(true);
  const [dbBackend, setDbBackend] = useState<string | null>(null);

  // Validation state
  const [cmdShake, setCmdShake] = useState(false);

  // Mission polling: elapsed timer + cancellation
  const [elapsedMs, setElapsedMs] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef  = useRef<HTMLInputElement>(null);

  // Health check — poll every 30s
  useEffect(() => {
    const check = () => {
      fetch(`${API_BASE_URL}/health`, { headers: apiHeaders() })
        .then(async r => {
          setSystemOnline(r.ok);
          if (r.ok) {
            try {
              const data = await r.json();
              setDbBackend(typeof data?.db_backend === 'string' ? data.db_backend : null);
            } catch { setDbBackend(null); }
          }
        })
        .catch(() => setSystemOnline(false));
    };
    check();
    const iv = setInterval(check, 30_000);
    return () => clearInterval(iv);
  }, []);

  // Auto-scroll
  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight, behavior: 'smooth' });
  }, [response, procLines]);

  // Simulate processing log
  useEffect(() => {
    if (!isRunning) { setProcLines([]); setProcIdx(0); return; }
    setProcLines([PROC_LINES[0]]);
    setProcIdx(1);
  }, [isRunning]);

  useEffect(() => {
    if (!isRunning || procIdx >= PROC_LINES.length) return;
    const t = setTimeout(() => {
      setProcLines(prev => [...prev, PROC_LINES[procIdx]]);
      setProcIdx(i => i + 1);
    }, 550);
    return () => clearTimeout(t);
  }, [isRunning, procIdx]);

  // Elapsed-time ticker: drives the `45s` counter in the running block so the
  // user can see progress while polling.
  useEffect(() => {
    if (!isRunning) { setElapsedMs(0); return; }
    const start = Date.now();
    setElapsedMs(0);
    const iv = setInterval(() => setElapsedMs(Date.now() - start), 500);
    return () => clearInterval(iv);
  }, [isRunning]);

  // ── Data fetching ──────────────────────────────────────────────
  const fetchLeads = useCallback(async (score?: number) => {
    const s = score ?? minScore;
    setLeadsLoading(true);
    setLeadsError(null);
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (s > 0) params.set('min_score', String(s));
      const res = await fetch(`${API_BASE_URL}/leads?${params}`, { headers: apiHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setLeads(data.leads ?? data ?? []);
    } catch (err: unknown) {
      setLeadsError(err instanceof Error ? err.message : 'Failed to load leads.');
    } finally {
      setLeadsLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchRuns = useCallback(async () => {
    setRunsLoading(true);
    setRunsError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/runs?user_id=${userId}&limit=20`, { headers: apiHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setRuns(await res.json());
    } catch (err: unknown) {
      setRunsError(err instanceof Error ? err.message : 'Failed to load history.');
    } finally {
      setRunsLoading(false);
    }
  }, [userId]);

  const fetchCampaigns = useCallback(async () => {
    setCampaignsLoading(true);
    setCampaignsError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/campaigns?limit=100`, { headers: apiHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setCampaigns(data.campaigns ?? data ?? []);
    } catch (err: unknown) {
      setCampaignsError(err instanceof Error ? err.message : 'Failed to load campaigns.');
    } finally {
      setCampaignsLoading(false);
    }
  }, []);

  const downloadCsv = useCallback(async (path: string, fallbackName: string): Promise<number> => {
    const res = await fetch(`${API_BASE_URL}${path}`, { headers: apiHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Prefer the server-supplied filename (has a timestamp); fall back to the
    // caller-provided stem if the header is missing or opaque to CORS.
    const disp = res.headers.get('content-disposition') ?? '';
    const match = /filename="?([^"]+)"?/i.exec(disp);
    const filename = match?.[1] ?? fallbackName;
    const text = await res.text();
    // Count newlines excluding header + trailing newline
    const lines = text.split(/\r?\n/).filter(Boolean);
    const rowCount = Math.max(0, lines.length - 1);
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return rowCount;
  }, []);

  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);
  const flashExportStatus = useCallback((kind: 'ok' | 'err', msg: string) => {
    setExportStatus({ kind, msg });
    window.setTimeout(() => setExportStatus(null), 4000);
  }, []);

  const exportLeads = useCallback(async () => {
    setExporting(true);
    setLeadsError(null);
    try {
      const params = new URLSearchParams({ limit: '5000' });
      if (minScore > 0) params.set('min_score', String(minScore));
      const count = await downloadCsv(`/leads/export.csv?${params}`, 'proplan-leads.csv');
      flashExportStatus('ok', `Exported ${count} lead${count === 1 ? '' : 's'}.`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Export failed.';
      setLeadsError(msg);
      flashExportStatus('err', `Export failed: ${msg}`);
    } finally {
      setExporting(false);
    }
  }, [downloadCsv, minScore, flashExportStatus]);

  const exportCampaigns = useCallback(async () => {
    setExporting(true);
    setCampaignsError(null);
    try {
      const count = await downloadCsv('/campaigns/export.csv?limit=5000', 'proplan-campaigns.csv');
      flashExportStatus('ok', `Exported ${count} campaign${count === 1 ? '' : 's'}.`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Export failed.';
      setCampaignsError(msg);
      flashExportStatus('err', `Export failed: ${msg}`);
    } finally {
      setExporting(false);
    }
  }, [downloadCsv, flashExportStatus]);

  // Slack integration
  const [slackStatus, setSlackStatus] = useState<{ kind: 'idle' | 'ok' | 'err'; msg?: string }>({ kind: 'idle' });
  const [slackBusy, setSlackBusy] = useState(false);

  const slackRequest = useCallback(async (path: string): Promise<{ ok: boolean; detail?: string }> => {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      method: 'POST',
      headers: apiHeaders({ 'Content-Type': 'application/json' }),
    });
    if (res.ok) return { ok: true };
    let detail: string | undefined;
    try {
      const body = await res.json();
      detail = typeof body?.detail === 'string' ? body.detail : `HTTP ${res.status}`;
    } catch {
      detail = `HTTP ${res.status}`;
    }
    return { ok: false, detail };
  }, []);

  const sendSlackTest = useCallback(async () => {
    setSlackBusy(true);
    setSlackStatus({ kind: 'idle' });
    // Save the profile first so the webhook URL in the draft is the one the
    // backend reads. If the save fails, abort — otherwise the ping below would
    // hit the *old* saved webhook and misleadingly report success.
    try {
      const save = await fetch(`${API_BASE_URL}/profile/${userId}`, {
        method: 'PUT',
        headers: apiHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ ...profileDraft, user_id: userId }),
      });
      if (!save.ok) {
        let detail = `HTTP ${save.status}`;
        try {
          const body = await save.json();
          if (typeof body?.detail === 'string') detail = body.detail;
        } catch { /* keep HTTP status */ }
        setSlackStatus({ kind: 'err', msg: `Profile save failed: ${detail}` });
        setSlackBusy(false);
        return;
      }
    } catch (err: unknown) {
      setSlackStatus({ kind: 'err', msg: err instanceof Error ? err.message : 'Profile save failed.' });
      setSlackBusy(false);
      return;
    }
    const r = await slackRequest(`/integrations/slack/${encodeURIComponent(userId)}/test`);
    setSlackStatus(r.ok ? { kind: 'ok', msg: 'Test message sent.' } : { kind: 'err', msg: r.detail ?? 'Failed.' });
    setSlackBusy(false);
  }, [profileDraft, slackRequest, userId]);

  const sendSlackLeads = useCallback(async () => {
    setSlackBusy(true);
    setLeadsError(null);
    const params = new URLSearchParams({ limit: '10' });
    if (minScore > 0) params.set('min_score', String(minScore));
    const r = await slackRequest(`/integrations/slack/${encodeURIComponent(userId)}/leads?${params}`);
    if (r.ok) {
      flashExportStatus('ok', 'Lead digest posted to Slack.');
    } else {
      setLeadsError(r.detail ?? 'Slack send failed.');
    }
    setSlackBusy(false);
  }, [minScore, slackRequest, userId, flashExportStatus]);

  // Load profile from API on mount (falls back to localStorage if unavailable)
  useEffect(() => {
    fetch(`${API_BASE_URL}/profile/${userId}`, { headers: apiHeaders() })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data) {
          const merged = { ...EMPTY_PROFILE, ...data };
          setProfile(merged);
          setProfileDraft(merged);
          localStorage.setItem(PROFILE_KEY, JSON.stringify(merged));
        }
      })
      .catch(() => { /* silently use localStorage */ });
  }, [userId]);

  // Fetch on view switch
  useEffect(() => {
    if (view === 'leads')     fetchLeads();
    if (view === 'campaigns') fetchCampaigns();
    if (view === 'history')   fetchRuns();
  }, [view, fetchLeads, fetchCampaigns, fetchRuns]);

  // ── Mission submit (async + polling with cancel) ──────────────
  const submit = async (e: React.BaseSyntheticEvent) => {
    e.preventDefault();
    if (isRunning) return;
    if (!prompt.trim()) {
      setCmdShake(true);
      inputRef.current?.focus();
      setTimeout(() => setCmdShake(false), 500);
      return;
    }
    setIsRunning(true);
    setMissionError(null);
    setResponse(null);

    const controller = new AbortController();
    abortRef.current = controller;
    const signal = controller.signal;

    // Abortable 2s gap between polls. Resolves on timeout; rejects with
    // AbortError the moment the user clicks CANCEL.
    const abortableSleep = (ms: number) => new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new DOMException('aborted', 'AbortError'));
      const t = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new DOMException('aborted', 'AbortError'));
      }, { once: true });
    });

    try {
      // 1. Dispatch
      const res = await fetch(`${API_BASE_URL}/agent/run`, {
        method: 'POST',
        headers: apiHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          user_id: userId,
          request: prompt,
          business_context: profileToContext(profile) ?? undefined,
        }),
        signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { run_id } = await res.json();

      // 2. Poll every 2s for up to 3 minutes
      for (let i = 0; i < 90; i++) {
        await abortableSleep(2000);
        const poll = await fetch(`${API_BASE_URL}/agent/run/status/${run_id}`, {
          headers: apiHeaders(),
          signal,
        });
        if (!poll.ok) throw new Error(`Poll failed: HTTP ${poll.status}`);
        const data = await poll.json();
        if (data.status === 'completed') { setResponse(data.result); return; }
        if (data.status === 'failed')    { throw new Error(data.error || 'Mission failed.'); }
      }
      throw new Error('Mission timed out after 3 minutes. Check History — the run may still complete in the background.');
    } catch (err: unknown) {
      const aborted =
        (err instanceof DOMException && err.name === 'AbortError') ||
        (err instanceof Error && err.name === 'AbortError');
      if (aborted) {
        setMissionError('Mission cancelled.');
      } else {
        setMissionError(err instanceof Error ? err.message : 'Connection failed.');
      }
    } finally {
      abortRef.current = null;
      setIsRunning(false);
    }
  };

  const cancelMission = () => {
    abortRef.current?.abort();
  };

  // ── Profile save (API first, then localStorage) ───────────────
  const saveProfile = async () => {
    setProfileSaveError(null);
    if (!profileComplete(profileDraft)) {
      setProfileSaveError('Company name, what we do, and ICP are required.');
      return;
    }
    try {
      const res = await fetch(`${API_BASE_URL}/profile/${userId}`, {
        method: 'PUT',
        headers: apiHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ ...profileDraft, user_id: userId }),
      });
      if (!res.ok) {
        let detail: string = `HTTP ${res.status}`;
        try {
          const body = await res.json();
          if (typeof body?.detail === 'string') detail = body.detail;
        } catch { /* response wasn't JSON; keep HTTP status */ }
        setProfileSaveError(detail);
        return;  // don't flash "SAVED" — the server rejected the write
      }
    } catch (err: unknown) {
      setProfileSaveError(err instanceof Error ? err.message : 'Network error — profile may not be persisted.');
      return;
    }
    // Only persist locally after the server confirms. Reloads now match what
    // Supabase actually holds, instead of the last draft the user typed.
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profileDraft));
    setProfile(profileDraft);
    setProfileSaved(true);
    setTimeout(() => setProfileSaved(false), 2000);
  };

  const resetMission = () => {
    setResponse(null);
    setMissionError(null);
    setPrompt('');
    setProcLines([]);
    setProcIdx(0);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const useTemplate = (t: string) => {
    setPrompt(t);
    // Select all text so next keystroke replaces the template.
    // requestAnimationFrame waits for React's re-render to flush before selecting.
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(0, el.value.length);
      }
    });
  };

  // ── Sidebar stats ──────────────────────────────────────────────
  const avgScore = leads.length
    ? Math.round(leads.reduce((a, l) => a + (l.icp_score ?? 0), 0) / leads.length)
    : null;

  const activeCampaigns = campaigns.filter(c => c.status.toLowerCase() === 'active').length;

  // ─── Render ───────────────────────────────────────────────────
  return (
    <div className="app-shell">
      <div className="scanlines" aria-hidden="true" />

      {/* ── Header ── */}
      <header className="app-header">
        <div className="header-left">
          <button
            type="button"
            className="header-brand"
            onClick={() => { setView('mission'); resetMission(); }}
            aria-label="Reset to mission home"
          >
            <Terminal size={14} className="header-icon" />
            <span className="brand-text">PROPLAN <span className="brand-slash">//</span> OS</span>
            <span className="brand-version">v2.0</span>
          </button>
          <div className="header-separator" />
          {/* View tabs */}
          <nav className="view-tabs" aria-label="Main navigation">
            {(['mission', 'leads', 'campaigns', 'history', 'profile'] as View[]).map(v => (
              <button
                key={v}
                type="button"
                className={`view-tab ${view === v ? 'view-tab-active' : ''}`}
                onClick={() => { setView(v); if (v === 'mission' && view === 'mission') resetMission(); }}
              >
                {v === 'mission'   && <Terminal  size={11} />}
                {v === 'leads'     && <Users      size={11} />}
                {v === 'campaigns' && <Megaphone  size={11} />}
                {v === 'history'   && <Activity   size={11} />}
                {v === 'profile'   && <Settings   size={11} />}
                {v.toUpperCase()}
                {v === 'profile' && !profileComplete(profile) && (
                  <span className="tab-dot-warn" title="Profile incomplete" />
                )}
              </button>
            ))}
          </nav>
        </div>

        <div className="header-status">
          <span className={`status-dot ${systemOnline ? '' : 'status-dot-err'}`} />
          <span className="status-label">{systemOnline ? 'SYSTEM ONLINE' : 'SYSTEM DEGRADED'}</span>
          <span className="status-pipe">|</span>
          <Activity size={11} />
          <span className="status-label">{systemOnline ? '4 AGENTS ACTIVE' : 'AGENTS UNAVAILABLE'}</span>
          {dbBackend && dbBackend !== 'supabase' && (
            <>
              <span className="status-pipe">|</span>
              <span
                className="status-label"
                style={{ color: 'var(--warn)' }}
                title="Database is running in in-memory mode. Leads and runs will not persist across restarts or serverless function instances. Configure SUPABASE_URL and SUPABASE_KEY on the backend."
              >
                DB: {dbBackend.toUpperCase()} (EPHEMERAL)
              </span>
            </>
          )}
        </div>
      </header>

      {/* ── Body ── */}
      <div className="app-body">

        {/* ── Sidebar ── */}
        <aside className="sidebar" aria-label="System dashboard">
          <section className="sidebar-section">
            <p className="sidebar-title">MISSION CONTROL</p>
            <div className="sidebar-stat">
              <span className="stat-label">SYSTEM</span>
              <span className="stat-value c-accent">READY</span>
            </div>
            <div className="sidebar-stat">
              <span className="stat-label">MODE</span>
              <span className="stat-value">AUTONOMOUS</span>
            </div>
            <div className="sidebar-stat">
              <span className="stat-label">SECURITY</span>
              <span className="stat-value c-accent">ENFORCED</span>
            </div>
          </section>

          <section className="sidebar-section">
            <p className="sidebar-title">AGENT REGISTRY</p>
            {Object.entries(AGENTS).map(([key, a]) => (
              <div key={key} className="agent-row">
                <span className="agent-badge"
                  style={{ color: a.color, borderColor: a.color + '44', backgroundColor: a.color + '12' }}
                  aria-label={`${a.label} agent`}>
                  {a.code}
                </span>
                <span className="agent-name">{a.label}</span>
                <span
                  className="agent-pip"
                  style={{ backgroundColor: a.color }}
                  title={`${a.label} — active`}
                  aria-label={`${a.label} status: active`}
                />
              </div>
            ))}
          </section>

          {/* Contextual sidebar sections */}
          {view === 'mission' && response && (
            <section className="sidebar-section">
              <p className="sidebar-title">LAST RUN</p>
              <div className="sidebar-stat">
                <span className="stat-label">STATUS</span>
                <span className={`stat-value ${runOutcome(response.status) === 'success' ? 'c-success' : 'c-warn'}`}>
                  {response.status.toUpperCase()}
                </span>
              </div>
              <div className="sidebar-stat">
                <span className="stat-label">TASKS</span>
                <span className="stat-value">{response.memory.length}</span>
              </div>
              <div className="sidebar-stat">
                <span className="stat-label">COST</span>
                <span className="stat-value">${response.total_cost.toFixed(4)}</span>
              </div>
              <div className="sidebar-stat">
                <span className="stat-label">RUN ID</span>
                <span
                  className="stat-value mono-xs stat-clickable"
                  title={`Click to copy: ${response.run_id}`}
                  onClick={() => navigator.clipboard.writeText(response.run_id)}
                >{response.run_id.slice(0, 14)}…</span>
              </div>
            </section>
          )}

          {view === 'leads' && (
            <section className="sidebar-section">
              <p className="sidebar-title">LEAD STATS</p>
              <div className="sidebar-stat">
                <span className="stat-label">TOTAL</span>
                <span className="stat-value">{leads.length}</span>
              </div>
              {avgScore !== null && (
                <div className="sidebar-stat">
                  <span className="stat-label">AVG SCORE</span>
                  <span className="stat-value" style={{ color: scoreColor(avgScore) }}>{avgScore}</span>
                </div>
              )}
              <div className="sidebar-stat">
                <span className="stat-label">HIGH FIT</span>
                <span className="stat-value c-accent">{leads.filter(l => (l.icp_score ?? 0) >= 70).length}</span>
              </div>
              <div className="sidebar-stat">
                <span className="stat-label">FROM AGENT</span>
                <span className="stat-value">{leads.filter(l => l.source === 'agent').length}</span>
              </div>
            </section>
          )}

          {view === 'campaigns' && (
            <section className="sidebar-section">
              <p className="sidebar-title">CAMPAIGN STATS</p>
              <div className="sidebar-stat">
                <span className="stat-label">TOTAL</span>
                <span className="stat-value">{campaigns.length}</span>
              </div>
              <div className="sidebar-stat">
                <span className="stat-label">ACTIVE</span>
                <span className="stat-value c-success">{activeCampaigns}</span>
              </div>
              <div className="sidebar-stat">
                <span className="stat-label">DRAFT</span>
                <span className="stat-value">{campaigns.filter(c => c.status === 'draft').length}</span>
              </div>
            </section>
          )}

          {view === 'history' && (
            <section className="sidebar-section">
              <p className="sidebar-title">RUN HISTORY</p>
              <div className="sidebar-stat">
                <span className="stat-label">TOTAL RUNS</span>
                <span className="stat-value">{runs.length}</span>
              </div>
              <div className="sidebar-stat">
                <span className="stat-label">COMPLETED</span>
                <span className="stat-value c-success">{runs.filter(r => r.status === 'completed').length}</span>
              </div>
              <div className="sidebar-stat">
                <span className="stat-label">TOTAL COST</span>
                <span className="stat-value c-accent">
                  ${runs.reduce((a, r) => a + (r.cost_usd ?? 0), 0).toFixed(4)}
                </span>
              </div>
              <div className="sidebar-stat">
                <span className="stat-label">USER ID</span>
                <span
                  className="stat-value mono-xs stat-clickable"
                  title={`Click to copy: ${userId}`}
                  onClick={() => navigator.clipboard.writeText(userId)}
                >{userId.slice(0, 14)}…</span>
              </div>
            </section>
          )}

          {view === 'profile' && (
            <section className="sidebar-section">
              <p className="sidebar-title">PROFILE STATUS</p>
              <div className="sidebar-stat">
                <span className="stat-label">COMPANY</span>
                <span className="stat-value" style={{ color: profile.company_name ? 'var(--text)' : 'var(--muted)' }}>
                  {profile.company_name || '—'}
                </span>
              </div>
              <div className="sidebar-stat">
                <span className="stat-label">ICP SET</span>
                <span className={`stat-value ${profile.icp ? 'c-success' : 'c-error'}`}>
                  {profile.icp ? 'YES' : 'NO'}
                </span>
              </div>
              <div className="sidebar-stat">
                <span className="stat-label">CONTEXT</span>
                <span className={`stat-value ${profileComplete(profile) ? 'c-accent' : 'c-warn'}`}>
                  {profileComplete(profile) ? 'ACTIVE' : 'INCOMPLETE'}
                </span>
              </div>
            </section>
          )}

          <div className="sidebar-footer">
            <Shield size={11} style={{ color: 'var(--muted)', flexShrink: 0, marginTop: 2 }} />
            <span className="sidebar-footnote">
              Per-agent budget, rate limits &amp; tool permissions enforced at runtime
            </span>
          </div>
        </aside>

        {/* ── Main ── */}
        <main className="main-area" aria-label="Content area">

          {/* ════ MISSION VIEW ════ */}
          {view === 'mission' && (
            <>
              <div className="output-feed" ref={outputRef}>
                {!response && !isRunning && !missionError && (
                  <div className="empty-state">
                    <div className="terminal-hero">
                      <div className="hero-border">{'─'.repeat(46)}</div>
                      <p className="hero-system">PROPLAN OS</p>
                      <p className="hero-sub">AUTONOMOUS MULTI-AGENT ORCHESTRATOR</p>
                      <p className="hero-await">AWAITING MISSION INPUT <span className="blink">█</span></p>
                      <div className="hero-border">{'─'.repeat(46)}</div>
                    </div>
                    <div className="templates-wrap">
                      <p className="templates-label">─── MISSION TEMPLATES ───</p>
                      {TEMPLATES.map((t, i) => (
                        <button key={t} type="button" className="template-btn" onClick={() => useTemplate(t)}>
                          <span className="template-num">{String(i + 1).padStart(2, '0')}</span>
                          <span className="template-text">{t}</span>
                          <Zap size={11} className="template-zap" />
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {isRunning && (
                  <div className="log-feed">
                    <div className="log-header">
                      <span className="log-ts">{ts()}</span>
                      <span className="log-evt c-accent">MISSION INITIATED</span>
                      <span className="log-evt" style={{ marginLeft: 'auto', color: 'var(--muted)' }}>
                        ELAPSED {Math.floor(elapsedMs / 1000)}s / 180s
                      </span>
                    </div>
                    <div className="log-mission">
                      <span className="log-field">INPUT</span>
                      <span className="log-val">{prompt}</span>
                    </div>
                    {procLines.map((line, i) => (
                      <div key={line} className="proc-line" style={{ animationDelay: `${i * 0.04}s` }}>
                        {line}
                      </div>
                    ))}
                    <div className="proc-line proc-cursor"><span className="blink">█</span></div>
                  </div>
                )}

                {missionError && (
                  <div className="log-feed">
                    <div className="log-header">
                      <span className="log-ts">{ts()}</span>
                      <XCircle size={12} style={{ color: 'var(--error)' }} />
                      <span className="log-evt c-error">MISSION FAILED</span>
                    </div>
                    <div className="error-box"><strong>ERR:</strong> {missionError}</div>
                    <button type="button" className="reset-btn" onClick={resetMission}>
                      <RefreshCw size={11} /> NEW MISSION
                    </button>
                  </div>
                )}

                {response && (() => {
                  const outcome = runOutcome(response.status);
                  const succeeded = response.memory.filter(s => s.result.success).length;
                  const failed = response.memory.length - succeeded;
                  return (
                  <div className="log-feed">
                    <div className="log-header">
                      <span className="log-ts">{ts()}</span>
                      {outcome === 'success'
                        ? <CheckCircle size={12} style={{ color: 'var(--success)' }} />
                        : <XCircle    size={12} style={{ color: 'var(--warn)' }} />}
                      <span className={`log-evt ${outcome === 'success' ? 'c-success' : 'c-warn'}`}>
                        {runStatusLabel(response.status)} — {succeeded}/{response.memory.length} TASK{response.memory.length !== 1 ? 'S' : ''} OK
                        {failed > 0 ? ` · ${failed} FAILED` : ''}
                      </span>
                    </div>

                    {response.persistence && (
                      response.persistence.errors.length > 0 ||
                      response.persistence.backend === 'memory' ||
                      (response.persistence.leads_extracted > 0 && response.persistence.leads_saved === 0)
                    ) && (
                      <div className="error-box" style={{ margin: '0 0 16px', borderColor: 'var(--warn)', color: 'var(--warn)' }}>
                        <strong>PERSISTENCE WARNING</strong>
                        <div style={{ marginTop: 6, fontSize: '0.85em', opacity: 0.9 }}>
                          <div>BACKEND: {response.persistence.backend.toUpperCase()}
                            {response.persistence.backend === 'memory' && ' — data will not survive a restart and is not visible across workers'}
                          </div>
                          <div>LEADS: extracted {response.persistence.leads_extracted} · saved {response.persistence.leads_saved}</div>
                          <div>RUN LOGGED: {response.persistence.session_logged ? 'yes' : 'no'}</div>
                          {response.persistence.errors.length > 0 && (
                            <ul style={{ margin: '6px 0 0 16px', padding: 0 }}>
                              {response.persistence.errors.map((err, i) => (
                                <li key={i} style={{ fontFamily: 'monospace', fontSize: '0.9em' }}>
                                  [{err.target}{typeof err.index === 'number' ? ` #${err.index}` : ''}] {err.error_type}: {err.message}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </div>
                    )}

                    {response.memory.map((step, i) => {
                      const a = getAgent(step.task.agent);
                      return (
                        <div key={step.task.id} className="task-block"
                          style={{ '--agent-color': a.color } as React.CSSProperties}>
                          <div className="task-header">
                            <span className="task-idx">{String(i + 1).padStart(2, '0')}</span>
                            <span className="task-badge"
                              style={{ color: a.color, borderColor: a.color + '55', backgroundColor: a.color + '15' }}>
                              {a.label}
                            </span>
                            <span className="task-action">{step.task.action.replace(/_/g, ' ').toUpperCase()}</span>
                            {step.result.success
                              ? <span className="task-ok">✓ OK</span>
                              : <span className="task-fail">✗ FAIL</span>}
                            {step.task.retries > 0 && <span className="task-retry">↻ {step.task.retries}</span>}
                          </div>
                          <div className="task-body">
                            <div className="task-col">
                              <p className="task-col-label">PAYLOAD</p>
                              <pre className="task-pre">{JSON.stringify(step.task.payload, null, 2)}</pre>
                            </div>
                            <div className="task-col">
                              <p className="task-col-label">OUTPUT</p>
                              {step.result.success ? (
                                <pre className="task-pre out">
                                  {typeof step.result.data === 'string'
                                    ? step.result.data
                                    : JSON.stringify(step.result.data, null, 2)}
                                </pre>
                              ) : (
                                <pre className="task-pre err">{step.result.error}</pre>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}

                    {Object.keys(response.cost_breakdown).length > 0 && (
                      <div className="cost-block">
                        <p className="cost-title">COST BREAKDOWN</p>
                        <div className="cost-rows">
                          {Object.entries(response.cost_breakdown).map(([taskId, cost]) => {
                            const label = taskId.length > 12 ? taskId.slice(0, 8).toUpperCase() + '…' : taskId.toUpperCase();
                            return (
                            <div key={taskId} className="cost-row">
                              <span className="cost-agent" title={taskId}>{label}</span>
                              <div className="cost-track">
                                <div className="cost-bar"
                                  style={{ width: `${(cost / response.total_cost) * 100}%`, backgroundColor: 'var(--accent)' }} />
                              </div>
                              <span className="cost-amt">${cost.toFixed(4)}</span>
                            </div>
                            );
                          })}
                          <div className="cost-total">
                            <span>TOTAL</span>
                            <span style={{ color: 'var(--accent)' }}>${response.total_cost.toFixed(4)}</span>
                          </div>
                        </div>
                      </div>
                    )}

                    <button type="button" className="reset-btn" onClick={resetMission}>
                      <RefreshCw size={11} /> NEW MISSION
                    </button>
                  </div>
                  );
                })()}
              </div>

              {/* Command bar */}
              <div className="cmd-bar">
                <form onSubmit={submit} className={`cmd-form ${cmdShake ? 'cmd-shake' : ''}`}>
                  <span className="cmd-prompt">[MISSION]&gt;</span>
                  <input
                    ref={inputRef}
                    id="mission-input"
                    name="mission"
                    type="text"
                    value={prompt}
                    onChange={e => setPrompt(e.target.value)}
                    placeholder="Describe your mission objective..."
                    className="cmd-input"
                    disabled={isRunning}
                    autoComplete="off"
                    spellCheck={false}
                    aria-label="Mission objective"
                  />
                  <button type="submit" disabled={isRunning} className="cmd-submit">
                    {isRunning
                      ? <span className="blink">EXEC…</span>
                      : <><span>DEPLOY</span><Send size={11} aria-hidden="true" /></>}
                  </button>
                  {isRunning && (
                    <button
                      type="button"
                      onClick={cancelMission}
                      className="cmd-submit"
                      style={{ marginLeft: 8, borderColor: 'var(--error)', color: 'var(--error)' }}
                      title="Abort the in-flight mission"
                    >
                      <XCircle size={11} aria-hidden="true" />
                      <span>CANCEL</span>
                    </button>
                  )}
                </form>
                <div className="cmd-hint">
                  {isRunning
                    ? 'CANCEL aborts the request client-side · the backend run continues until it naturally terminates'
                    : 'ENTER to deploy · select a template above to pre-fill · agents operate under enforced security policy'}
                </div>
              </div>
            </>
          )}

          {/* ════ LEADS VIEW ════ */}
          {view === 'leads' && (
            <div className="data-view">
              <div className="data-toolbar">
                <div className="toolbar-left">
                  <span className="toolbar-title">LEAD DATABASE</span>
                  <span className="toolbar-count">{leads.length} RECORDS</span>
                </div>
                <div className="toolbar-right">
                  <label className="filter-label">
                    MIN SCORE
                    <select
                      className="filter-select"
                      value={minScore}
                      onChange={e => { const v = +e.target.value; setMinScore(v); fetchLeads(v); }}
                    >
                      <option value={0}>ALL</option>
                      <option value={40}>40+</option>
                      <option value={70}>70+</option>
                      <option value={90}>90+</option>
                    </select>
                  </label>
                  <button type="button" className="toolbar-btn" onClick={() => fetchLeads()} disabled={leadsLoading}>
                    <RefreshCw size={11} className={leadsLoading ? 'spin' : ''} />
                    REFRESH
                  </button>
                  <button
                    type="button"
                    className="toolbar-btn"
                    onClick={exportLeads}
                    disabled={exporting || leads.length === 0}
                    title={leads.length === 0 ? 'No leads to export' : 'Download current view as CSV'}
                  >
                    <Download size={11} />
                    EXPORT CSV
                  </button>
                  <button
                    type="button"
                    className="toolbar-btn"
                    onClick={sendSlackLeads}
                    disabled={slackBusy || leads.length === 0}
                    title={
                      leads.length === 0
                        ? 'No leads to send'
                        : 'Post the top 10 leads in this view to your Slack channel'
                    }
                  >
                    <MessageSquare size={11} />
                    SEND TO SLACK
                  </button>
                </div>
              </div>

              {exportStatus && (
                <div
                  className="error-box"
                  style={
                    exportStatus.kind === 'ok'
                      ? {
                          margin: '0 0 12px',
                          fontSize: 12,
                          background: 'rgba(57, 255, 20, 0.05)',
                          borderColor: 'rgba(57, 255, 20, 0.22)',
                          borderLeftColor: 'var(--success)',
                          color: 'var(--success)',
                        }
                      : { margin: '0 0 12px', fontSize: 12 }
                  }
                >
                  {exportStatus.kind === 'ok'
                    ? <CheckCircle size={11} style={{ verticalAlign: '-2px', marginRight: 6 }} />
                    : <XCircle size={11} style={{ verticalAlign: '-2px', marginRight: 6 }} />}
                  {exportStatus.msg}
                </div>
              )}

              {leadsError && <div className="error-box" style={{ margin: '0 0 16px' }}><strong>ERR:</strong> {leadsError}</div>}

              {leadsLoading && (
                <div className="data-loading">
                  <span className="blink">█</span> QUERYING DATABASE...
                </div>
              )}

              {!leadsLoading && leads.length === 0 && !leadsError && (
                <div className="data-empty">
                  <Users size={28} style={{ color: 'var(--muted)', marginBottom: 12 }} />
                  <p>NO LEADS ON RECORD</p>
                  <p className="data-empty-sub">Run a mission with the Sales agent to populate this table.</p>
                </div>
              )}

              {!leadsLoading && leads.length > 0 && (
                <div className="data-table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>NAME</th>
                        <th>SCORE</th>
                        <th>FIT</th>
                        <th>SOURCE</th>
                        <th>ID</th>
                      </tr>
                    </thead>
                    <tbody>
                      {leads.map((lead, i) => (
                        <tr key={lead.id}>
                          <td className="td-muted">{String(i + 1).padStart(2, '0')}</td>
                          <td className="td-name">{lead.full_name}</td>
                          <td>
                            <div className="score-cell">
                              <span className="score-num" style={{ color: scoreColor(lead.icp_score ?? 0) }}>
                                {lead.icp_score ?? '—'}
                              </span>
                              <div className="score-track">
                                <div className="score-bar"
                                  style={{ width: `${lead.icp_score ?? 0}%`, backgroundColor: scoreColor(lead.icp_score ?? 0) }} />
                              </div>
                            </div>
                          </td>
                          <td>
                            <span className="fit-badge"
                              style={{ color: scoreColor(lead.icp_score ?? 0), borderColor: scoreColor(lead.icp_score ?? 0) + '44', backgroundColor: scoreColor(lead.icp_score ?? 0) + '12' }}>
                              {(lead.icp_score ?? 0) >= 70 ? 'HIGH' : (lead.icp_score ?? 0) >= 40 ? 'MID' : 'LOW'}
                            </span>
                          </td>
                          <td>
                            <span className="source-badge">{lead.source.toUpperCase()}</span>
                          </td>
                          <td className="td-id">{lead.id.slice(0, 12)}…</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ════ CAMPAIGNS VIEW ════ */}
          {view === 'campaigns' && (
            <div className="data-view">
              <div className="data-toolbar">
                <div className="toolbar-left">
                  <span className="toolbar-title">CAMPAIGN REGISTRY</span>
                  <span className="toolbar-count">{campaigns.length} RECORDS</span>
                </div>
                <div className="toolbar-right">
                  <button type="button" className="toolbar-btn" onClick={fetchCampaigns} disabled={campaignsLoading}>
                    <RefreshCw size={11} className={campaignsLoading ? 'spin' : ''} />
                    REFRESH
                  </button>
                  <button
                    type="button"
                    className="toolbar-btn"
                    onClick={exportCampaigns}
                    disabled={exporting || campaigns.length === 0}
                    title={campaigns.length === 0 ? 'No campaigns to export' : 'Download all campaigns as CSV'}
                  >
                    <Download size={11} />
                    EXPORT CSV
                  </button>
                </div>
              </div>

              {exportStatus && (
                <div
                  className="error-box"
                  style={
                    exportStatus.kind === 'ok'
                      ? {
                          margin: '0 0 12px',
                          fontSize: 12,
                          background: 'rgba(57, 255, 20, 0.05)',
                          borderColor: 'rgba(57, 255, 20, 0.22)',
                          borderLeftColor: 'var(--success)',
                          color: 'var(--success)',
                        }
                      : { margin: '0 0 12px', fontSize: 12 }
                  }
                >
                  {exportStatus.kind === 'ok'
                    ? <CheckCircle size={11} style={{ verticalAlign: '-2px', marginRight: 6 }} />
                    : <XCircle size={11} style={{ verticalAlign: '-2px', marginRight: 6 }} />}
                  {exportStatus.msg}
                </div>
              )}

              {campaignsError && <div className="error-box" style={{ margin: '0 0 16px' }}><strong>ERR:</strong> {campaignsError}</div>}

              {campaignsLoading && (
                <div className="data-loading">
                  <span className="blink">█</span> QUERYING DATABASE...
                </div>
              )}

              {!campaignsLoading && campaigns.length === 0 && !campaignsError && (
                <div className="data-empty">
                  <Megaphone size={28} style={{ color: 'var(--muted)', marginBottom: 12 }} />
                  <p>NO CAMPAIGNS ON RECORD</p>
                  <p className="data-empty-sub">Run a mission with the Marketing agent to populate this table.</p>
                </div>
              )}

              {!campaignsLoading && campaigns.length > 0 && (
                <div className="data-table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>NAME</th>
                        <th>STATUS</th>
                        <th>CREATED</th>
                        <th>ID</th>
                      </tr>
                    </thead>
                    <tbody>
                      {campaigns.map((c, i) => (
                        <tr key={c.id}>
                          <td className="td-muted">{String(i + 1).padStart(2, '0')}</td>
                          <td className="td-name">{c.name}</td>
                          <td>
                            <span className="status-badge"
                              style={{ color: statusColor(c.status), borderColor: statusColor(c.status) + '44', backgroundColor: statusColor(c.status) + '12' }}>
                              {c.status.toUpperCase()}
                            </span>
                          </td>
                          <td className="td-muted">{formatDate(c.created_at)}</td>
                          <td className="td-id">{c.id.slice(0, 12)}…</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ════ HISTORY VIEW ════ */}
          {view === 'history' && (
            <div className="data-view">
              <div className="data-toolbar">
                <div className="toolbar-left">
                  <span className="toolbar-title">MISSION HISTORY</span>
                  <span className="toolbar-count">{runs.length} RUNS</span>
                </div>
                <div className="toolbar-right">
                  <button type="button" className="toolbar-btn" onClick={fetchRuns} disabled={runsLoading}>
                    <RefreshCw size={11} className={runsLoading ? 'spin' : ''} />
                    REFRESH
                  </button>
                </div>
              </div>

              {runsError && <div className="error-box" style={{ margin: '0 0 16px' }}><strong>ERR:</strong> {runsError}</div>}

              {runsLoading && (
                <div className="data-loading">
                  <span className="blink">█</span> QUERYING DATABASE...
                </div>
              )}

              {!runsLoading && runs.length === 0 && !runsError && (
                <div className="data-empty">
                  <Activity size={28} style={{ color: 'var(--muted)', marginBottom: 12 }} />
                  <p>NO RUNS ON RECORD</p>
                  <p className="data-empty-sub">Your mission history will appear here after your first run.</p>
                </div>
              )}

              {!runsLoading && runs.length > 0 && (
                <div className="data-table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>MISSION</th>
                        <th>STATUS</th>
                        <th>COST</th>
                        <th>DATE</th>
                      </tr>
                    </thead>
                    <tbody>
                      {runs.map((run, i) => (
                        <tr key={run.id}>
                          <td className="td-muted">{String(i + 1).padStart(2, '0')}</td>
                          <td className="td-name" style={{ maxWidth: 340 }}>
                            {run.input_data?.request
                              ? run.input_data.request.length > 72
                                ? run.input_data.request.slice(0, 72) + '…'
                                : run.input_data.request
                              : '—'}
                          </td>
                          <td>
                            <span className="status-badge" style={{
                              color: run.status === 'completed' ? 'var(--success)' : run.status === 'failed' ? 'var(--error)' : 'var(--warn)',
                              borderColor: (run.status === 'completed' ? 'var(--success)' : run.status === 'failed' ? 'var(--error)' : 'var(--warn)') + '44',
                              backgroundColor: (run.status === 'completed' ? 'var(--success)' : run.status === 'failed' ? 'var(--error)' : 'var(--warn)') + '12',
                            }}>
                              {run.status.toUpperCase()}
                            </span>
                          </td>
                          <td style={{ color: 'var(--accent)' }}>
                            {run.cost_usd != null ? `$${run.cost_usd.toFixed(4)}` : '—'}
                          </td>
                          <td className="td-muted">
                            {run.started_at ? new Date(run.started_at).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ════ PROFILE VIEW ════ */}
          {view === 'profile' && (
            <div className="profile-view">
              <div className="profile-header">
                <div>
                  <p className="profile-title">BUSINESS PROFILE</p>
                  <p className="profile-subtitle">
                    This context is silently injected into every agent run. Fill it once — agents remember forever.
                  </p>
                </div>
                <button
                  className={`profile-save-btn ${profileSaved ? 'profile-save-btn-ok' : ''}`}
                  onClick={saveProfile}
                >
                  {profileSaved
                    ? <><CheckCircle size={11} /> SAVED</>
                    : <><Save size={11} /> SAVE PROFILE</>}
                </button>
              </div>

              {profileSaveError && (
                <div className="profile-banner" style={{ borderColor: 'var(--error)', color: 'var(--error)' }}>
                  <AlertTriangle size={11} style={{ color: 'var(--error)', flexShrink: 0 }} />
                  <span><strong>SAVE FAILED:</strong> {profileSaveError}</span>
                </div>
              )}

              {!profileComplete(profile) && (
                <div className="profile-banner">
                  <Zap size={11} style={{ color: 'var(--warn)', flexShrink: 0 }} />
                  <span>Profile incomplete — agents are operating without business context. Fill in at least Company, Description, and ICP.</span>
                </div>
              )}

              <div className="profile-form">
                {/* Section: Identity */}
                <div className="profile-section">
                  <p className="profile-section-title">── IDENTITY ──────────────────────</p>

                  <div className="profile-field">
                    <label className="profile-label">COMPANY NAME <span className="profile-req">*</span></label>
                    <input
                      className="profile-input"
                      value={profileDraft.company_name}
                      onChange={e => setProfileDraft(d => ({ ...d, company_name: e.target.value }))}
                      placeholder="e.g. Acme SaaS"
                    />
                  </div>

                  <div className="profile-field">
                    <label className="profile-label">WHAT WE DO <span className="profile-req">*</span></label>
                    <textarea
                      className="profile-textarea"
                      rows={2}
                      value={profileDraft.what_we_do}
                      onChange={e => setProfileDraft(d => ({ ...d, what_we_do: e.target.value }))}
                      placeholder="e.g. Project management tool for construction firms"
                    />
                  </div>

                  <div className="profile-field">
                    <label className="profile-label">VALUE PROPOSITION</label>
                    <textarea
                      className="profile-textarea"
                      rows={2}
                      value={profileDraft.value_proposition}
                      onChange={e => setProfileDraft(d => ({ ...d, value_proposition: e.target.value }))}
                      placeholder="e.g. We cut project overruns by 30% through automated scheduling"
                    />
                  </div>
                </div>

                {/* Section: Target Market */}
                <div className="profile-section">
                  <p className="profile-section-title">── TARGET MARKET ─────────────────</p>

                  <div className="profile-field">
                    <label className="profile-label">IDEAL CUSTOMER PROFILE (ICP) <span className="profile-req">*</span></label>
                    <textarea
                      className="profile-textarea"
                      rows={2}
                      value={profileDraft.icp}
                      onChange={e => setProfileDraft(d => ({ ...d, icp: e.target.value }))}
                      placeholder="e.g. Ops managers at construction companies, 50–500 employees, US-based"
                    />
                  </div>

                  <div className="profile-row">
                    <div className="profile-field">
                      <label className="profile-label">TARGET INDUSTRIES</label>
                      <input
                        className="profile-input"
                        value={profileDraft.target_industries}
                        onChange={e => setProfileDraft(d => ({ ...d, target_industries: e.target.value }))}
                        placeholder="e.g. Construction, Real Estate, Manufacturing"
                      />
                    </div>
                    <div className="profile-field">
                      <label className="profile-label">COMPANY SIZE</label>
                      <input
                        className="profile-input"
                        value={profileDraft.company_size}
                        onChange={e => setProfileDraft(d => ({ ...d, company_size: e.target.value }))}
                        placeholder="e.g. 10–500 employees"
                      />
                    </div>
                  </div>

                  <div className="profile-row">
                    <div className="profile-field">
                      <label className="profile-label">GEOGRAPHY</label>
                      <input
                        className="profile-input"
                        value={profileDraft.geography}
                        onChange={e => setProfileDraft(d => ({ ...d, geography: e.target.value }))}
                        placeholder="e.g. US, Canada"
                      />
                    </div>
                    <div className="profile-field">
                      <label className="profile-label">COMMUNICATION TONE</label>
                      <select
                        className="profile-select"
                        value={profileDraft.tone}
                        onChange={e => setProfileDraft(d => ({ ...d, tone: e.target.value }))}
                      >
                        <option value="professional">Professional</option>
                        <option value="direct">Direct &amp; concise</option>
                        <option value="casual">Casual &amp; friendly</option>
                        <option value="consultative">Consultative</option>
                        <option value="bold">Bold &amp; assertive</option>
                      </select>
                    </div>
                  </div>
                </div>

                {/* Section: Lead Intelligence */}
                <div className="profile-section">
                  <p className="profile-section-title">── LEAD INTELLIGENCE ─────────────</p>

                  <div className="profile-field">
                    <label className="profile-label">QUALIFICATION SIGNALS</label>
                    <textarea
                      className="profile-textarea"
                      rows={2}
                      value={profileDraft.lead_signals}
                      onChange={e => setProfileDraft(d => ({ ...d, lead_signals: e.target.value }))}
                      placeholder="e.g. Posted job for 'project coordinator', uses Procore, raised Series A funding"
                    />
                    <p className="profile-hint">What signals indicate a lead is a strong fit for your product?</p>
                  </div>
                </div>

                {/* Section: Integrations */}
                <div className="profile-section">
                  <p className="profile-section-title">── INTEGRATIONS ──────────────────</p>

                  <div className="profile-field">
                    <label className="profile-label">SLACK INCOMING WEBHOOK URL</label>
                    <input
                      className="profile-input"
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      value={profileDraft.slack_webhook_url}
                      onChange={e => setProfileDraft(d => ({ ...d, slack_webhook_url: e.target.value }))}
                      placeholder="https://hooks.slack.com/services/..."
                    />
                    <p className="profile-hint">
                      Create one at api.slack.com/apps → Incoming Webhooks. Used to send lead digests to your channel.
                    </p>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                      {(() => {
                        const testDisabled = slackBusy || !profileDraft.slack_webhook_url.trim();
                        return (
                          <button
                            type="button"
                            className="toolbar-btn"
                            onClick={sendSlackTest}
                            disabled={testDisabled}
                            title={testDisabled && !slackBusy ? 'Paste a webhook URL above, then click SAVE PROFILE before testing.' : undefined}
                            style={testDisabled ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
                          >
                            <MessageSquare size={11} />
                            {slackBusy ? 'TESTING…' : 'TEST'}
                          </button>
                        );
                      })()}
                      {slackStatus.kind === 'ok' && (
                        <span style={{ color: 'var(--success)', fontSize: 11 }}>
                          <CheckCircle size={11} style={{ verticalAlign: '-2px', marginRight: 4 }} />
                          {slackStatus.msg}
                        </span>
                      )}
                      {slackStatus.kind === 'err' && (
                        <span style={{ color: 'var(--error)', fontSize: 11 }}>
                          <XCircle size={11} style={{ verticalAlign: '-2px', marginRight: 4 }} />
                          {slackStatus.msg}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

        </main>
      </div>
    </div>
  );
}
