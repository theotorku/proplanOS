import { useMemo } from 'react';
import './dashboard.css';

// Kept narrow on purpose — only the fields the dashboard reads.
type Lead = {
  id: string;
  full_name: string;
  icp_score: number | null;
  source: string;
};

type RunHistory = {
  id: string;
  run_id: string | null;
  status: string;
  input_data: { request?: string; user_id?: string } | null;
  output_data: { total_cost?: number; status?: string } | null;
  cost_usd: number | null;
  started_at: string | null;
};

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
  total_cost: number;
  cost_breakdown: Record<string, number>;
  memory: TaskMemory[];
};

type AgentMeta = { label: string; color: string; code: string };

export type MissionControlProps = {
  leads: Lead[];
  runs: RunHistory[];
  response: OrchestratorResponse | null;
  isRunning: boolean;
  companyName: string;
  agents: Record<string, AgentMeta>;
  templates: string[];
  onUseTemplate: (t: string) => void;
};

function fmtTs(iso: string | null): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch { return '—'; }
}

function short(s: string, max = 52): string {
  if (!s) return '';
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function scoreBand(s: number): 'HIGH' | 'MID' | 'LOW' {
  if (s >= 70) return 'HIGH';
  if (s >= 40) return 'MID';
  return 'LOW';
}

function bandColor(band: 'HIGH' | 'MID' | 'LOW'): string {
  return band === 'HIGH' ? 'var(--accent)' : band === 'MID' ? 'var(--warn)' : 'var(--muted)';
}

export default function MissionControl({
  leads, runs, response, isRunning, companyName, agents, templates, onUseTemplate,
}: MissionControlProps) {
  // ── KPIs ────────────────────────────────────────────────
  const totalLeads = leads.length;
  const highIcp = leads.filter(l => (l.icp_score ?? 0) >= 70).length;
  const avgScore = totalLeads
    ? Math.round(leads.reduce((a, l) => a + (l.icp_score ?? 0), 0) / totalLeads)
    : 0;

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const runsToday = runs.filter(r => {
    if (!r.started_at) return false;
    const d = new Date(r.started_at);
    return d >= today;
  }).length;

  const totalSpend = runs.reduce((a, r) => a + (r.cost_usd ?? 0), 0);

  // ── 14-day pipeline chart ───────────────────────────────
  const chartData = useMemo(() => {
    const days: { label: string; iso: string; count: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      const iso = d.toISOString().slice(0, 10);
      days.push({ label: d.toLocaleDateString(undefined, { day: '2-digit' }), iso, count: 0 });
    }
    for (const r of runs) {
      if (!r.started_at) continue;
      const key = new Date(r.started_at).toISOString().slice(0, 10);
      const slot = days.find(x => x.iso === key);
      if (slot) slot.count += 1;
    }
    return days;
  }, [runs]);

  const chartMax = Math.max(1, ...chartData.map(d => d.count));
  const chartW = 560;
  const chartH = 140;
  const barW = chartW / chartData.length - 6;

  // ── Live lead (top ICP) ─────────────────────────────────
  const topLead = useMemo(() => {
    const withScore = leads.filter(l => (l.icp_score ?? 0) > 0);
    if (!withScore.length) return null;
    return withScore.reduce((best, cur) =>
      (cur.icp_score ?? 0) > (best.icp_score ?? 0) ? cur : best, withScore[0]);
  }, [leads]);

  const topScore = topLead?.icp_score ?? 0;
  const topBand = scoreBand(topScore);
  const topBandC = bandColor(topBand);

  // ── Agent fleet — walk each run's memory, attribute by task.agent ──
  // cost_breakdown is keyed by task.id, memory entries carry task.agent —
  // joining the two lets us tally runs and spend per agent registry key
  // ('sales' / 'marketing' / 'support' / 'ops') which is what the cards expect.
  const agentStats = useMemo(() => {
    const agg: Record<string, { runs: number; cost: number }> = {};
    for (const r of runs) {
      const out = r.output_data as unknown as {
        memory?: TaskMemory[];
        cost_breakdown?: Record<string, number>;
      } | null;
      const memory = out?.memory ?? [];
      const breakdown = out?.cost_breakdown ?? {};
      for (const entry of memory) {
        const agent = entry?.task?.agent;
        if (!agent) continue;
        const cost = breakdown[entry.task.id] ?? 0;
        agg[agent] = agg[agent] ?? { runs: 0, cost: 0 };
        agg[agent].runs += 1;
        agg[agent].cost += cost;
      }
    }
    return agg;
  }, [runs]);

  // ── Live feed from recent runs ─────────────────────────
  const feedRows = useMemo(() => {
    return runs.slice(0, 6).map(r => {
      const req = r.input_data?.request ?? '(no request text)';
      return {
        id: r.id,
        ts: fmtTs(r.started_at),
        status: (r.status || 'pending').toUpperCase(),
        msg: short(req, 64),
        cost: r.cost_usd != null ? `$${r.cost_usd.toFixed(2)}` : '—',
      };
    });
  }, [runs]);

  // ── Replay: prefer the in-flight response, otherwise fall back to the
  //    most recent completed run so the panel survives a page refresh and
  //    populates even when the user lands on Mission Control without
  //    having just dispatched a mission.
  const replay = useMemo(() => {
    if (response?.memory?.length) return response.memory.slice(0, 6);
    const lastCompleted = runs.find(r => {
      const mem = (r.output_data as unknown as { memory?: TaskMemory[] } | null)?.memory;
      return Array.isArray(mem) && mem.length > 0;
    });
    const mem = (lastCompleted?.output_data as unknown as { memory?: TaskMemory[] } | null)?.memory;
    return mem ? mem.slice(0, 6) : [];
  }, [response, runs]);

  return (
    <div className="mc-wrap">
      {/* Hero */}
      <header className="mc-hero">
        <div>
          <div className="mc-hero-title">
            Mission <em>Control</em>
          </div>
          <div className="mc-hero-sub">
            {companyName || 'Operator'} · Live fleet overview
          </div>
        </div>
        <div className="mc-hero-meta">
          <span className="dot" />
          <span>{isRunning ? 'Mission in flight' : 'Fleet standing by'}</span>
        </div>
      </header>

      {/* KPI strip */}
      <div className="mc-kpis">
        <div className="mc-kpi">
          <span className="mc-kpi-label">Total leads</span>
          <span className="mc-kpi-value">{totalLeads}</span>
          <span className="mc-kpi-delta">{highIcp} high-ICP · avg {avgScore}</span>
        </div>
        <div className="mc-kpi">
          <span className="mc-kpi-label">Runs today</span>
          <span className="mc-kpi-value">{runsToday}</span>
          <span className="mc-kpi-delta">{runs.length} total in history</span>
        </div>
        <div className="mc-kpi">
          <span className="mc-kpi-label">Spend (all-time)</span>
          <span className="mc-kpi-value">${totalSpend.toFixed(2)}</span>
          <span className="mc-kpi-delta">
            avg ${runs.length ? (totalSpend / runs.length).toFixed(2) : '0.00'}/run
          </span>
        </div>
        <div className="mc-kpi">
          <span className="mc-kpi-label">Fleet status</span>
          <span className="mc-kpi-value">{Object.keys(agents).length}/{Object.keys(agents).length}</span>
          <span className="mc-kpi-delta up">All agents online</span>
        </div>
      </div>

      {/* Left column */}
      <div className="mc-col">
        {/* Agent Fleet */}
        <section className="mc-card">
          <header className="mc-card-header">
            <span className="mc-card-title">Agent Fleet</span>
            <span className="mc-card-meta">{Object.keys(agents).length} agents · live</span>
          </header>
          <div className="mc-agents">
            {Object.entries(agents).map(([key, a]) => {
              const s = agentStats[key] ?? { runs: 0, cost: 0 };
              const active = isRunning || s.runs > 0;
              return (
                <article key={key} className="mc-agent">
                  <div className="mc-agent-top">
                    <div
                      className="mc-agent-code"
                      style={{
                        background: `${a.color}18`,
                        border: `1px solid ${a.color}55`,
                        color: a.color,
                      }}
                    >{a.code}</div>
                    <div>
                      <div className="mc-agent-name">{a.label}</div>
                      <div className="mc-agent-role">{key}</div>
                    </div>
                    <div className={`mc-agent-state ${active ? 'active' : ''}`}>
                      <span className="dot" />{active ? 'Active' : 'Idle'}
                    </div>
                  </div>
                  <div className="mc-agent-metrics">
                    <div className="mc-agent-metric">
                      <span className="k">Runs</span>
                      <span className="v">{s.runs}</span>
                    </div>
                    <div className="mc-agent-metric">
                      <span className="k">Spend</span>
                      <span className="v">${s.cost.toFixed(2)}</span>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        {/* Pipeline chart */}
        <section className="mc-card">
          <header className="mc-card-header">
            <span className="mc-card-title">Pipeline · 14 days</span>
            <span className="mc-card-meta">Runs per day</span>
          </header>
          <div className="mc-chart">
            <svg
              className="mc-chart-svg"
              viewBox={`0 0 ${chartW} ${chartH + 20}`}
              preserveAspectRatio="none"
              aria-label="14-day run volume"
            >
              {[0.25, 0.5, 0.75].map(g => (
                <line
                  key={g}
                  x1={0} y1={chartH * g}
                  x2={chartW} y2={chartH * g}
                  className="mc-chart-grid"
                />
              ))}
              {chartData.map((d, i) => {
                const h = (d.count / chartMax) * (chartH - 8);
                const x = i * (chartW / chartData.length) + 3;
                const y = chartH - h;
                return (
                  <g key={d.iso}>
                    <rect
                      x={x} y={y}
                      width={barW} height={h}
                      rx={2}
                      className={`mc-chart-bar ${d.count === 0 ? 'dim' : ''}`}
                    />
                    {i % 2 === 0 && (
                      <text
                        x={x + barW / 2}
                        y={chartH + 14}
                        textAnchor="middle"
                        className="mc-chart-label"
                      >{d.label}</text>
                    )}
                  </g>
                );
              })}
            </svg>
            <div className="mc-chart-legend">
              <span>
                <span className="sw" style={{ background: 'var(--accent)' }} />
                Runs dispatched
              </span>
            </div>
          </div>
        </section>

        {/* Live Feed */}
        <section className="mc-card">
          <header className="mc-card-header">
            <span className="mc-card-title">Live Feed</span>
            <span className="mc-card-meta">Last {feedRows.length || 0} runs</span>
          </header>
          <div className="mc-feed">
            {feedRows.length === 0 ? (
              <div className="mc-feed-empty">No missions yet — dispatch one below.</div>
            ) : feedRows.map(f => {
              const isOk = f.status === 'COMPLETED';
              const isErr = f.status === 'FAILED';
              const c = isOk ? 'var(--success)' : isErr ? 'var(--error)' : 'var(--warn)';
              return (
                <div key={f.id} className="mc-feed-row">
                  <span className="mc-feed-ts">{f.ts}</span>
                  <span
                    className="mc-feed-tag"
                    style={{ color: c, borderColor: `${c}55`, background: `${c}12` }}
                  >{f.status}</span>
                  <span className="mc-feed-msg">{f.msg}</span>
                  <span className="mc-feed-cost">{f.cost}</span>
                </div>
              );
            })}
          </div>
        </section>
      </div>

      {/* Right column */}
      <div className="mc-col">
        {/* Live lead */}
        <section className="mc-card">
          <header className="mc-card-header">
            <span className="mc-card-title">Top Live Lead</span>
            <span className="mc-card-meta">{totalLeads} in pipeline</span>
          </header>
          <div className="mc-lead-body">
            {topLead ? (
              <>
                <div className="mc-lead-name">{topLead.full_name}</div>
                <div className="mc-lead-source">
                  Source · {topLead.source || '—'}
                </div>
                <div className="mc-lead-score">
                  <span className="mc-lead-score-num" style={{ color: topBandC }}>
                    {topScore}
                  </span>
                  <div className="mc-lead-score-track">
                    <div className="mc-lead-score-bar" style={{ width: `${topScore}%` }} />
                  </div>
                  <span
                    className="mc-lead-band"
                    style={{ color: topBandC, borderColor: `${topBandC}55`, background: `${topBandC}14` }}
                  >{topBand}</span>
                </div>
              </>
            ) : (
              <div className="mc-feed-empty" style={{ padding: 0 }}>
                No scored leads yet. Run a mission to populate the pipeline.
              </div>
            )}
          </div>
        </section>

        {/* Deploy / composer hint */}
        <section className="mc-card">
          <header className="mc-card-header">
            <span className="mc-card-title">Deploy Mission</span>
            <span className="mc-card-meta">Terminal below</span>
          </header>
          <div className="mc-deploy">
            <div className="mc-deploy-hint">
              <strong>Give the fleet an objective.</strong> Type below or tap a preset.
            </div>
            <div className="mc-deploy-templates">
              {templates.map((t, i) => (
                <button
                  key={t}
                  type="button"
                  className="mc-template"
                  onClick={() => onUseTemplate(t)}
                  title={t}
                >
                  <span style={{ color: 'var(--accent)', fontWeight: 700, marginRight: 6 }}>
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  {short(t, 60)}
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* Mission Replay */}
        <section className="mc-card">
          <header className="mc-card-header">
            <span className="mc-card-title">Mission Replay</span>
            <span className="mc-card-meta">{response ? `run ${response.run_id.slice(0, 8)}` : 'No recent run'}</span>
          </header>
          <div className="mc-replay">
            {replay.length === 0 ? (
              <div className="mc-replay-empty">Replay appears here after a mission completes.</div>
            ) : replay.map((m, i) => {
              const a = agents[m.task.agent.toLowerCase()];
              const color = a?.color ?? 'var(--muted)';
              const ok = m.result.success;
              return (
                <div
                  key={m.task.id}
                  className="mc-replay-step"
                  style={{ ['--agent-color' as string]: color }}
                >
                  <span className="mc-replay-idx">{String(i + 1).padStart(2, '0')}</span>
                  <span
                    className="mc-replay-tag"
                    style={{ color, background: `${color}18`, border: `1px solid ${color}44` }}
                  >{a?.code ?? m.task.agent.slice(0, 2).toUpperCase()}</span>
                  <span className="mc-replay-action">{short(m.task.action, 46)}</span>
                  <span
                    className="mc-replay-status"
                    style={{ color: ok ? 'var(--success)' : 'var(--error)' }}
                  >{ok ? 'OK' : 'ERR'}</span>
                </div>
              );
            })}
          </div>
        </section>

        {/* Queue */}
        <section className="mc-card">
          <header className="mc-card-header">
            <span className="mc-card-title">Queue</span>
            <span className="mc-card-meta">{isRunning ? '1 active' : 'Empty'}</span>
          </header>
          <div className="mc-queue">
            {isRunning ? (
              <div className="mc-queue-row live">
                <span className="mc-queue-dot" />
                <span className="mc-queue-label">Mission dispatch in progress…</span>
                <span className="mc-queue-state">Running</span>
              </div>
            ) : (
              <div className="mc-queue-row">
                <span className="mc-queue-dot" />
                <span className="mc-queue-label">No queued missions</span>
                <span className="mc-queue-state">Idle</span>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
