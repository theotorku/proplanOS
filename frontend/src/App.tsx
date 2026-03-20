import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Terminal, Activity, Shield, Zap, CheckCircle, XCircle, RefreshCw, Users, Megaphone } from 'lucide-react';

const API_BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8000';

// ─── Types ──────────────────────────────────────────────────────
type View = 'mission' | 'leads' | 'campaigns';

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

type OrchestratorResponse = {
  status: string;
  run_id: string;
  user_id: string;
  total_cost: number;
  cost_breakdown: Record<string, number>;
  memory: TaskMemory[];
};

type Lead = {
  id: string;
  name: string;
  score: number;
  source: string;
};

type Campaign = {
  id: string;
  name: string;
  status: string;
  created_at: number;
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
  '> Parsing mission parameters...',
  '> Planner LLM generating task graph...',
  '> Security layer: permissions validated...',
  '> Rate limit check — OK',
  '> Budget gate — OK',
  '> Dispatching to registered agent pool...',
  '> Executing task queue...',
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

function formatDate(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString('en-US', {
    month: 'short', day: '2-digit', year: 'numeric',
  });
}

// ─── Component ───────────────────────────────────────────────────
export default function App() {
  // View
  const [view, setView] = useState<View>('mission');

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

  // Validation state
  const [cmdShake, setCmdShake] = useState(false);

  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef  = useRef<HTMLInputElement>(null);

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

  // ── Data fetching ──────────────────────────────────────────────
  const fetchLeads = useCallback(async (score = minScore) => {
    setLeadsLoading(true);
    setLeadsError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/leads?min_score=${score}&limit=100`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setLeads(data.leads ?? data ?? []);
    } catch (err: unknown) {
      setLeadsError(err instanceof Error ? err.message : 'Failed to load leads.');
    } finally {
      setLeadsLoading(false);
    }
  }, [minScore]);

  const fetchCampaigns = useCallback(async () => {
    setCampaignsLoading(true);
    setCampaignsError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/campaigns?limit=100`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setCampaigns(data.campaigns ?? data ?? []);
    } catch (err: unknown) {
      setCampaignsError(err instanceof Error ? err.message : 'Failed to load campaigns.');
    } finally {
      setCampaignsLoading(false);
    }
  }, []);

  // Fetch on view switch
  useEffect(() => {
    if (view === 'leads')     fetchLeads();
    if (view === 'campaigns') fetchCampaigns();
  }, [view, fetchLeads, fetchCampaigns]);

  // ── Mission submit ─────────────────────────────────────────────
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

    try {
      const res = await fetch(`${API_BASE_URL}/agent/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: 'user-demo', request: prompt }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setResponse(await res.json());
    } catch (err: unknown) {
      setMissionError(err instanceof Error ? err.message : 'Connection failed.');
    } finally {
      setIsRunning(false);
    }
  };

  const useTemplate = (t: string) => {
    setPrompt(t);
    // Select all text so next keystroke replaces the template
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
  };

  // ── Sidebar stats ──────────────────────────────────────────────
  const avgScore = leads.length
    ? Math.round(leads.reduce((a, l) => a + l.score, 0) / leads.length)
    : null;

  const activeCampaigns = campaigns.filter(c => c.status.toLowerCase() === 'active').length;

  // ─── Render ───────────────────────────────────────────────────
  return (
    <div className="app-shell">
      <div className="scanlines" aria-hidden="true" />

      {/* ── Header ── */}
      <header className="app-header">
        <div className="header-left">
          <div className="header-brand">
            <Terminal size={14} className="header-icon" />
            <span className="brand-text">PROPLAN <span className="brand-slash">//</span> OS</span>
            <span className="brand-version">v2.0</span>
          </div>
          <div className="header-separator" />
          {/* View tabs */}
          <nav className="view-tabs">
            {(['mission', 'leads', 'campaigns'] as View[]).map(v => (
              <button
                key={v}
                className={`view-tab ${view === v ? 'view-tab-active' : ''}`}
                onClick={() => setView(v)}
              >
                {v === 'mission'   && <Terminal  size={11} />}
                {v === 'leads'     && <Users      size={11} />}
                {v === 'campaigns' && <Megaphone  size={11} />}
                {v.toUpperCase()}
              </button>
            ))}
          </nav>
        </div>

        <div className="header-status">
          <span className="status-dot" />
          <span className="status-label">SYSTEM ONLINE</span>
          <span className="status-pipe">|</span>
          <Activity size={11} />
          <span className="status-label">4 AGENTS ACTIVE</span>
        </div>
      </header>

      {/* ── Body ── */}
      <div className="app-body">

        {/* ── Sidebar ── */}
        <aside className="sidebar">
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
                  style={{ color: a.color, borderColor: a.color + '44', backgroundColor: a.color + '12' }}>
                  {a.code}
                </span>
                <span className="agent-name">{a.label}</span>
                <span className="agent-pip" style={{ backgroundColor: a.color }} />
              </div>
            ))}
          </section>

          {/* Contextual sidebar sections */}
          {view === 'mission' && response && (
            <section className="sidebar-section">
              <p className="sidebar-title">LAST RUN</p>
              <div className="sidebar-stat">
                <span className="stat-label">STATUS</span>
                <span className="stat-value c-success">{response.status.toUpperCase()}</span>
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
                <span className="stat-value c-accent">{leads.filter(l => l.score >= 70).length}</span>
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

          <div className="sidebar-footer">
            <Shield size={11} style={{ color: 'var(--muted)', flexShrink: 0, marginTop: 2 }} />
            <span className="sidebar-footnote">
              Per-agent budget, rate limits &amp; tool permissions enforced at runtime
            </span>
          </div>
        </aside>

        {/* ── Main ── */}
        <main className="main-area">

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
                        <button key={i} className="template-btn" onClick={() => useTemplate(t)}>
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
                    </div>
                    <div className="log-mission">
                      <span className="log-field">INPUT</span>
                      <span className="log-val">{prompt}</span>
                    </div>
                    {procLines.map((line, i) => (
                      <div key={i} className="proc-line" style={{ animationDelay: `${i * 0.04}s` }}>
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
                  </div>
                )}

                {response && (
                  <div className="log-feed">
                    <div className="log-header">
                      <span className="log-ts">{ts()}</span>
                      <CheckCircle size={12} style={{ color: 'var(--success)' }} />
                      <span className="log-evt c-success">
                        MISSION COMPLETE — {response.memory.length} TASK{response.memory.length !== 1 ? 'S' : ''} EXECUTED
                      </span>
                    </div>

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
                  </div>
                )}
              </div>

              {/* Command bar */}
              <div className="cmd-bar">
                <form onSubmit={submit} className={`cmd-form ${cmdShake ? 'cmd-shake' : ''}`}>
                  <span className="cmd-prompt">[MISSION]&gt;</span>
                  <input
                    ref={inputRef}
                    type="text"
                    value={prompt}
                    onChange={e => setPrompt(e.target.value)}
                    placeholder="Describe your mission objective..."
                    className="cmd-input"
                    disabled={isRunning}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button type="submit" disabled={isRunning || !prompt.trim()} className="cmd-submit">
                    {isRunning
                      ? <span className="blink">EXEC…</span>
                      : <><span>DEPLOY</span><Send size={11} /></>}
                  </button>
                </form>
                <div className="cmd-hint">
                  ENTER to deploy · select a template above to pre-fill · agents operate under enforced security policy
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
                      onChange={e => { setMinScore(+e.target.value); fetchLeads(+e.target.value); }}
                    >
                      <option value={0}>ALL</option>
                      <option value={40}>40+</option>
                      <option value={70}>70+</option>
                      <option value={90}>90+</option>
                    </select>
                  </label>
                  <button className="toolbar-btn" onClick={() => fetchLeads()} disabled={leadsLoading}>
                    <RefreshCw size={11} className={leadsLoading ? 'spin' : ''} />
                    REFRESH
                  </button>
                </div>
              </div>

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
                          <td className="td-name">{lead.name}</td>
                          <td>
                            <div className="score-cell">
                              <span className="score-num" style={{ color: scoreColor(lead.score) }}>
                                {lead.score}
                              </span>
                              <div className="score-track">
                                <div className="score-bar"
                                  style={{ width: `${lead.score}%`, backgroundColor: scoreColor(lead.score) }} />
                              </div>
                            </div>
                          </td>
                          <td>
                            <span className="fit-badge"
                              style={{ color: scoreColor(lead.score), borderColor: scoreColor(lead.score) + '44', backgroundColor: scoreColor(lead.score) + '12' }}>
                              {lead.score >= 70 ? 'HIGH' : lead.score >= 40 ? 'MID' : 'LOW'}
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
                  <button className="toolbar-btn" onClick={fetchCampaigns} disabled={campaignsLoading}>
                    <RefreshCw size={11} className={campaignsLoading ? 'spin' : ''} />
                    REFRESH
                  </button>
                </div>
              </div>

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

        </main>
      </div>
    </div>
  );
}
