import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './onboard.css';
import { EMPTY_STATE } from './types';
import type { OnboardProfile, OnboardState, OnboardStepId } from './types';

const API_BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8000';

const STATE_KEY = 'proplan_onboard_state';
const ONBOARDED_KEY = 'proplan_onboarded';

const STEPS: Array<{ id: OnboardStepId; title: string; sub: string }> = [
  { id: 'url',   title: 'Business profile',        sub: 'URL · 30s' },
  { id: 'verti', title: 'Pick your beachhead',     sub: 'Vertical · 20s' },
  { id: 'goals', title: 'Choose your wins',        sub: 'Goals · 30s' },
  { id: 'integ', title: 'Connect your stack',      sub: 'Integrations · 2m' },
  { id: 'fleet', title: 'Activate your fleet',     sub: 'Four agents · 1m' },
  { id: 'brief', title: 'Launch your first mission', sub: 'Live · 1m' },
  { id: 'done',  title: "You're live",             sub: 'Handoff' },
];

// ─── Icons ──────────────────────────────────────────────────────
const ArrowIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M5 12h14" />
    <path d="M13 5l7 7-7 7" />
  </svg>
);
const CheckIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true">
    <path d="M4 12l6 6L20 6" />
  </svg>
);
const PencilIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
  </svg>
);

// ─── Props shared by step components ────────────────────────────
type StepProps = {
  state: OnboardState;
  setState: (updater: (prev: OnboardState) => OnboardState) => void;
  next: () => void;
  back?: () => void;
};

// ─── Brand mark (shared with the app, but scoped inside rail) ───
function Brand() {
  return (
    <div className="brand">
      <div className="brand-mark">P</div>
      <div>
        ProPlan <em>OS</em>
      </div>
    </div>
  );
}

// ─── Shared nav row ─────────────────────────────────────────────
function StageNav(props: {
  progress: string;
  canNext: boolean;
  next: () => void;
  back?: () => void;
  nextLabel?: string;
  skip?: () => void;
}) {
  const { progress, canNext, next, back, nextLabel = 'Continue', skip } = props;
  return (
    <div className="stage-nav">
      <div className="left">
        {back && (
          <button type="button" className="btn btn-ghost" onClick={back} aria-label="Previous step">
            ← Back
          </button>
        )}
        <span className="stage-progress">STEP {progress}</span>
      </div>
      <div className="center">
        {skip && (
          <button type="button" className="btn btn-ghost" onClick={skip}>
            Skip — connect later
          </button>
        )}
        <button
          type="button"
          className="btn btn-primary btn-big"
          onClick={next}
          disabled={!canNext}
          aria-label={nextLabel}
        >
          {nextLabel} <ArrowIcon />
        </button>
      </div>
    </div>
  );
}

// ─── Step 1: URL scan ──────────────────────────────────────────
function StepUrl({ state, setState, next }: StepProps) {
  const [url, setUrl] = useState(state.url || '');
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<keyof OnboardProfile | null>(null);
  const profile = state.profile;

  const scan = useCallback(async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setScanning(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/onboard/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: trimmed }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error(detail?.detail ?? `Scan failed (${res.status})`);
      }
      const data: OnboardProfile = await res.json();
      setState(s => ({ ...s, url: trimmed, profile: data, vertical: data.vertical ?? s.vertical }));
    } catch (e) {
      // Soft failure — let the operator fill the fields manually and continue.
      const msg = e instanceof Error ? e.message : String(e);
      setError(`${msg}. You can fill the profile manually below.`);
      setState(s => ({
        ...s,
        url: trimmed,
        profile: s.profile ?? {
          company: null, url: trimmed.replace(/^https?:\/\//, ''), owner: null,
          location: null, vertical: null, services: null, years_operating: null, review: null,
        },
      }));
    } finally {
      setScanning(false);
    }
  }, [url, setState]);

  const updateField = (key: keyof OnboardProfile, value: string) => {
    setState(s => ({
      ...s,
      profile: s.profile ? { ...s.profile, [key]: value || null } : s.profile,
    }));
  };

  const fields: Array<{ key: keyof OnboardProfile; label: string }> = [
    { key: 'owner', label: 'Owner' },
    { key: 'location', label: 'Location' },
    { key: 'vertical', label: 'Vertical' },
    { key: 'services', label: 'Services' },
    { key: 'years_operating', label: 'Operating' },
  ];

  return (
    <div>
      <div className="stage-head">
        <div className="stage-eyebrow">Step 1 of 6</div>
        <h1 className="stage-title">
          Let's start with your <em>website</em>.
        </h1>
        <p className="stage-sub">
          Drop in your URL. We'll pre-fill your business profile in about 3 seconds — no forms, no
          questionnaires.
        </p>
      </div>

      <div className="input-group">
        <input
          className="input-big"
          placeholder="https://your-business.com"
          value={url}
          onChange={e => setUrl(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && scan()}
          aria-label="Business website URL"
        />
        <button
          type="button"
          className="btn btn-primary btn-big"
          onClick={scan}
          disabled={scanning || !url.trim()}
        >
          {scanning ? 'Scanning…' : (<>Scan <ArrowIcon /></>)}
        </button>
      </div>

      {error && <div className="scan-error" role="alert">{error}</div>}

      {(scanning || profile) && (
        <div className={`scan-result ${scanning || profile ? 'on' : ''}`} aria-live="polite">
          <div className="scan-top">
            <div className="scan-favicon">
              {profile?.company ? profile.company[0] : '…'}
            </div>
            <div style={{ flex: 1 }}>
              <div className="scan-name">
                {profile?.company ?? <span className="typing-caret">Reading the site</span>}
              </div>
              <div className="scan-url">{profile?.url || url || '—'}</div>
            </div>
            {profile && <span className="scan-chip">PROFILE READY</span>}
          </div>

          {profile && (
            <div className="scan-grid">
              {fields.map(f => {
                const raw = profile[f.key];
                const value = typeof raw === 'string' ? raw : '';
                const isEditing = editing === f.key;
                return (
                  <div key={f.key} className="scan-field">
                    <div className="k">{f.label}</div>
                    {isEditing ? (
                      <input
                        autoFocus
                        defaultValue={value}
                        onBlur={e => { updateField(f.key, e.target.value); setEditing(null); }}
                        onKeyDown={e => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                          if (e.key === 'Escape') setEditing(null);
                        }}
                        aria-label={`Edit ${f.label}`}
                      />
                    ) : (
                      <div className="v">
                        {value || <span className="v-empty">Not found — click to add</span>}
                      </div>
                    )}
                    {!isEditing && (
                      <button
                        type="button"
                        className="edit-btn"
                        onClick={() => setEditing(f.key)}
                        aria-label={`Edit ${f.label}`}
                      >
                        <PencilIcon />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {profile?.review && (
        <div className="proof-review">
          <div className="eyebrow">Already found · recent customer review</div>
          <div className="stars">{'★'.repeat(Math.max(0, Math.min(5, profile.review.rating)))}</div>
          <div className="quote">"{profile.review.text}"</div>
          <div className="meta">
            — {profile.review.author}
            {profile.review.when ? ` · ${profile.review.when}` : ''}
          </div>
        </div>
      )}

      <StageNav progress="1 / 6" canNext={!!profile} next={next} />
    </div>
  );
}

// ─── Step 2: Vertical ───────────────────────────────────────────
function StepVertical({ state, setState, next, back }: StepProps) {
  const verts = [
    { id: 'roofing',    icon: '▲', title: 'Home services',       desc: 'Roofing, HVAC, remodels, plumbing, electrical', tag: 'Your beachhead' },
    { id: 'realestate', icon: '◆', title: 'Real estate',         desc: 'Brokerages, property managers, short-term rental ops', tag: 'Active' },
    { id: 'healthcare', icon: '✚', title: 'Healthcare practices', desc: 'Dental, optometry, physical therapy, clinics', tag: 'Beta' },
  ];
  const pick = state.vertical || 'roofing';
  return (
    <div>
      <div className="stage-head">
        <div className="stage-eyebrow">Step 2 of 6</div>
        <h1 className="stage-title">Your <em>beachhead</em>.</h1>
        <p className="stage-sub">
          Agents get sharper when they know who they're selling to. Pick one vertical — you can add
          more later.
        </p>
      </div>
      <div className="card-grid">
        {verts.map(v => (
          <button
            key={v.id}
            type="button"
            className={`pick-card ${pick === v.id ? 'on' : ''}`}
            onClick={() => setState(s => ({ ...s, vertical: v.id }))}
            aria-pressed={pick === v.id}
          >
            <div className="pick-icon">{v.icon}</div>
            <div className="pick-title">{v.title}</div>
            <div className="pick-desc">{v.desc}</div>
            <div className="pick-tag">{v.tag}</div>
          </button>
        ))}
      </div>
      <StageNav progress="2 / 6" canNext back={back} next={next} />
    </div>
  );
}

// ─── Step 3: Goals ──────────────────────────────────────────────
function StepGoals({ state, setState, next, back }: StepProps) {
  const goals = [
    { id: 'respond', title: 'Respond to every lead in <60s', sub: 'SALES-01' },
    { id: 'book',    title: 'Book more estimates',           sub: 'SALES-01 · OPS-04' },
    { id: 'nurture', title: 'Re-engage cold leads',          sub: 'MKTG-02' },
    { id: 'content', title: 'Ship content every week',       sub: 'MKTG-02' },
    { id: 'tickets', title: 'Clear the support backlog',     sub: 'SUPP-03' },
    { id: 'route',   title: 'Route jobs to the right crew',  sub: 'OPS-04' },
  ];
  const picked = new Set(state.goals);
  const toggle = (id: string) => {
    const n = new Set(picked);
    n.has(id) ? n.delete(id) : n.add(id);
    setState(s => ({ ...s, goals: [...n] }));
  };
  return (
    <div>
      <div className="stage-head">
        <div className="stage-eyebrow">Step 3 of 6</div>
        <h1 className="stage-title">What wins are we <em>chasing</em>?</h1>
        <p className="stage-sub">
          We'll tune your agents and your first mission based on what you pick. Two to four is the
          sweet spot.
        </p>
      </div>
      <div className="goals">
        {goals.map(g => (
          <button
            key={g.id}
            type="button"
            className={`goal ${picked.has(g.id) ? 'on' : ''}`}
            onClick={() => toggle(g.id)}
            aria-pressed={picked.has(g.id)}
          >
            <div className="goal-check" aria-hidden="true">
              {picked.has(g.id) && <CheckIcon />}
            </div>
            <div>
              <div className="goal-title">{g.title}</div>
              <div className="goal-sub">{g.sub}</div>
            </div>
          </button>
        ))}
      </div>
      <StageNav progress="3 / 6" canNext={picked.size > 0} back={back} next={next} />
    </div>
  );
}

// ─── Step 4: Integrations ───────────────────────────────────────
function StepIntegrations({ state, setState, next, back }: StepProps) {
  const integs = [
    { id: 'jobber',   name: 'Jobber',          desc: 'Scheduling & CRM for home services', color: '#1E8E3E', letter: 'J' },
    { id: 'gcal',     name: 'Google Calendar', desc: 'Estimate visits + crew blocks',       color: '#4285F4', letter: 'G' },
    { id: 'twilio',   name: 'Twilio SMS',      desc: 'Outbound texts & lead follow-ups',    color: '#E21C3C', letter: 'T' },
    { id: 'gmail',    name: 'Gmail',           desc: 'Send + read conversation threads',    color: '#EA4335', letter: 'M' },
    { id: 'qb',       name: 'QuickBooks',      desc: 'Invoices & revenue data',             color: '#2CA01C', letter: 'Q' },
    { id: 'calendly', name: 'Calendly',        desc: 'Auto-book sales rep meetings',        color: '#006BFF', letter: 'C' },
  ];
  const connected = new Set(state.integrations);
  const toggle = (id: string) => {
    const n = new Set(connected);
    n.has(id) ? n.delete(id) : n.add(id);
    setState(s => ({ ...s, integrations: [...n] }));
  };
  return (
    <div>
      <div className="stage-head">
        <div className="stage-eyebrow">Step 4 of 6</div>
        <h1 className="stage-title">Connect the tools you <em>already use</em>.</h1>
        <p className="stage-sub">
          Skip anything you don't use. You can come back for the rest later — most onboarders connect
          three now.
        </p>
      </div>
      <div className="integ-grid">
        {integs.map(i => (
          <button
            key={i.id}
            type="button"
            className={`integ ${connected.has(i.id) ? 'on' : ''}`}
            onClick={() => toggle(i.id)}
            aria-pressed={connected.has(i.id)}
          >
            <div className="integ-logo" style={{ background: i.color }}>{i.letter}</div>
            <div>
              <div className="integ-name">{i.name}</div>
              <div className="integ-desc">{i.desc}</div>
            </div>
            <span className="integ-status">{connected.has(i.id) ? 'CONNECTED' : 'CONNECT'}</span>
          </button>
        ))}
      </div>
      <div className="integ-tip">
        <b>Tip —</b> leads connected to Jobber + a calendar close ~3× faster because OPS-04 can offer
        live-available slots on first reply.
      </div>
      <StageNav
        progress="4 / 6"
        canNext
        back={back}
        next={next}
        skip={() => { setState(s => ({ ...s, integrations: [] })); next(); }}
      />
    </div>
  );
}

// ─── Step 5: Fleet activation ───────────────────────────────────
const FLEET_AGENTS = [
  { id: 'SALES-01', name: 'Sales Agent',       role: 'Qualifies & routes every inbound lead in under 60s' },
  { id: 'MKTG-02',  name: 'Marketing Agent',   role: 'Drafts, sends & tunes campaigns across your channels' },
  { id: 'SUPP-03',  name: 'Support Agent',     role: 'Triages tickets, replies, and escalates only when needed' },
  { id: 'OPS-04',   name: 'Operations Agent',  role: 'Schedules, routes crews, and chases follow-ups' },
];

function StepFleet({ state: _state, next, back }: StepProps) {
  const agents = FLEET_AGENTS;
  const [status, setStatus] = useState<('offline' | 'booting' | 'online')[]>(
    ['offline', 'offline', 'offline', 'offline']
  );

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    agents.forEach((_, i) => {
      timers.push(
        setTimeout(() => setStatus(s => { const n = [...s]; n[i] = 'booting'; return n; }),
          300 + i * 700)
      );
      timers.push(
        setTimeout(() => setStatus(s => { const n = [...s]; n[i] = 'online'; return n; }),
          300 + i * 700 + 1200)
      );
    });
    return () => { timers.forEach(clearTimeout); };
  }, [agents]);

  const allOnline = status.every(s => s === 'online');

  return (
    <div>
      <div className="stage-head">
        <div className="stage-eyebrow">Step 5 of 6</div>
        <h1 className="stage-title">Bringing your <em>fleet</em> online.</h1>
        <p className="stage-sub">
          Each agent is being briefed on your business, your goals, and your stack. This usually
          takes about 10 seconds.
        </p>
      </div>
      <div className="fleet-activate" aria-live="polite">
        {agents.map((a, i) => (
          <div key={a.id} className={`activate-card ${status[i]}`}>
            <div className="astat">
              {status[i] === 'offline' ? 'QUEUED' : status[i] === 'booting' ? 'BOOTING' : 'ONLINE'}
            </div>
            <div className="code">{a.id}</div>
            <div className="aname">{a.name}</div>
            <div className="arole">{a.role}</div>
            <div className="aprog" />
          </div>
        ))}
      </div>
      <StageNav
        progress="5 / 6"
        canNext={allOnline}
        back={back}
        next={next}
        nextLabel={allOnline ? 'Brief your first mission' : 'Booting…'}
      />
    </div>
  );
}

// ─── Step 6: First mission brief ────────────────────────────────
function StepBrief({ state, next, back }: StepProps) {
  const vertLabel = (
    { roofing: 'home services', realestate: 'real estate', healthcare: 'healthcare' } as const
  )[state.vertical as 'roofing' | 'realestate' | 'healthcare'] ?? 'home services';
  const profile = state.profile;

  const [deploying, setDeploying] = useState(false);
  const [progress, setProgress] = useState(0);

  const steps = [
    'Parsing your goals & stack',
    'Drafting mission plan for SALES-01',
    'Pulling 32 matching prospects',
    'Enriching contacts & intent signals',
    'Ready for deployment',
  ];

  const deploy = () => {
    setDeploying(true);
    let step = 0;
    const id = setInterval(() => {
      step++;
      setProgress(step);
      if (step >= steps.length) {
        clearInterval(id);
        setTimeout(next, 600);
      }
    }, 700);
  };

  return (
    <div>
      <div className="stage-head">
        <div className="stage-eyebrow">Step 6 of 6 · Final step</div>
        <h1 className="stage-title">Your first <em>mission</em> is ready.</h1>
        <p className="stage-sub">
          We wrote this brief for you based on everything above. Approve it and SALES-01 goes to work
          immediately.
        </p>
      </div>
      <div className="brief-card">
        <div className="brief-row">
          <span className="k">Agent</span>
          <span className="v">SALES-01 · <em>Sales Agent</em></span>
        </div>
        <div className="brief-row">
          <span className="k">For</span>
          <span className="v">{profile?.company || 'Your business'}</span>
        </div>
        <div className="brief-row">
          <span className="k">Objective</span>
          <span className="v">
            Respond to every new lead in <em>under 60 seconds</em>, qualify, and book the hot ones.
          </span>
        </div>
        <div className="brief-row">
          <span className="k">Scope</span>
          <span className="v">
            All inbound web, Google LSA, and referral sources. {vertLabel} focus.
          </span>
        </div>
        <div className="brief-row">
          <span className="k">Playbook</span>
          <span className="v">
            Default — <em>budget 60, timeline 25, fit 10, urgency 5</em>.
          </span>
        </div>
        <div className="brief-row">
          <span className="k">Handoff</span>
          <span className="v">
            HOT → senior rep + Calendly link · WARM → nurture drip #14 · COLD → polite decline
          </span>
        </div>
        <div className="brief-row">
          <span className="k">Budget</span>
          <span className="v">$3/day agent spend · pauses at 50 missions/mo (Operator plan)</span>
        </div>
      </div>

      {deploying && (
        <div className="deploy-steps" aria-live="polite">
          {steps.map((s, i) => {
            const state = i < progress ? 'done' : i === progress ? 'running' : 'pending';
            return (
              <div key={i} className={`deploy-step ${state}`}>
                <span className="num">{state === 'done' ? '✓' : i + 1}</span>
                <span className="label">{s}</span>
                {state === 'running' && <span className="tick">RUNNING…</span>}
              </div>
            );
          })}
        </div>
      )}

      <StageNav
        progress="6 / 6"
        canNext
        back={back}
        next={deploying ? () => undefined : deploy}
        nextLabel={deploying ? 'Deploying…' : 'Approve & deploy'}
      />
    </div>
  );
}

// ─── Step 7: Done / celebration ─────────────────────────────────
function StepDone({
  state,
  onComplete,
}: {
  state: OnboardState;
  onComplete: () => void;
}) {
  const triggered = useRef(false);
  const handleFinish = () => {
    if (triggered.current) return;
    triggered.current = true;
    onComplete();
  };

  const elapsedMs = state.startedAt ? Date.now() - state.startedAt : 0;
  const mins = Math.floor(elapsedMs / 60000);
  const secs = Math.floor((elapsedMs % 60000) / 1000);

  return (
    <div>
      <div className="celebrate">
        <div className="celebrate-mark">✓</div>
        <h2>
          Your fleet is <em>live</em>.
        </h2>
        <p>
          Four agents are now watching your business 24/7. First mission is already running — check
          mission control for live updates.
        </p>

        <div className="proof-stats">
          <div className="proof-stat">
            <div className="n">
              <em>{mins}</em>m {secs.toString().padStart(2, '0')}s
            </div>
            <div className="l">Total setup time</div>
          </div>
          <div className="proof-stat">
            <div className="n"><em>4</em>/4</div>
            <div className="l">Agents online</div>
          </div>
          <div className="proof-stat">
            <div className="n"><em>32</em></div>
            <div className="l">Prospects in first mission</div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 12 }}>
          <button
            type="button"
            className="btn btn-primary btn-big"
            onClick={handleFinish}
          >
            Open Mission Control <ArrowIcon />
          </button>
        </div>

        <div
          style={{
            marginTop: 40,
            fontFamily: 'var(--pp-mono)',
            fontSize: 11,
            color: 'var(--pp-ink-dim)',
            letterSpacing: '0.1em',
          }}
        >
          WE'LL EMAIL YOU A WEEKLY MISSION REPORT · CANCEL ANYTIME · NO AGENT GOES ROGUE
        </div>
      </div>
    </div>
  );
}

// ─── Persistence helpers ────────────────────────────────────────
function loadState(): OnboardState | null {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as OnboardState;
  } catch { /* ignore corrupt state */ }
  return null;
}

function saveState(step: number, state: OnboardState) {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify({ ...state, _step: step }));
  } catch { /* quota — ignore */ }
}

function clearState() {
  try { localStorage.removeItem(STATE_KEY); } catch { /* ignore */ }
}

// ─── Map onboarding → BusinessProfile (existing app shape) ──────
function onboardingToBusinessProfile(state: OnboardState) {
  const p = state.profile;
  const goalToSignal: Record<string, string> = {
    respond: 'Fast response (<60s) to inbound leads',
    book:    'Books estimates / site visits',
    nurture: 'Re-engages cold leads',
    content: 'Weekly content cadence',
    tickets: 'Clears support backlog',
    route:   'Routes jobs to the right crew',
  };
  const vertIndustry: Record<string, string> = {
    roofing:    'Home services (roofing, HVAC, remodels, plumbing, electrical)',
    realestate: 'Real estate — brokerages and property managers',
    healthcare: 'Healthcare practices (dental, optometry, clinics)',
  };
  return {
    company_name: p?.company ?? '',
    what_we_do: p?.services ?? '',
    icp: p?.location ? `Customers in ${p.location}` : '',
    target_industries: vertIndustry[state.vertical] ?? '',
    company_size: '',
    geography: p?.location ?? '',
    lead_signals: state.goals.map(g => goalToSignal[g]).filter(Boolean).join('; '),
    value_proposition: '',
    tone: 'professional',
    slack_webhook_url: '',
  };
}

// ─── Main Onboarding component ──────────────────────────────────
export default function Onboarding({ userId, onComplete }: {
  userId: string;
  onComplete: () => void;
}) {
  const saved = useMemo(loadState, []);
  const savedStep = (saved as (OnboardState & { _step?: number }) | null)?._step ?? 0;

  const [step, setStep] = useState<number>(savedStep);
  const [state, setState] = useState<OnboardState>(() => {
    if (saved) return saved;
    const token = new URLSearchParams(window.location.search).get('t');
    return { ...EMPTY_STATE, token, startedAt: Date.now() };
  });

  // Load prefill if a token is present and we haven't already applied it.
  const prefillRan = useRef(false);
  useEffect(() => {
    if (prefillRan.current) return;
    prefillRan.current = true;
    const token = state.token;
    if (!token) return;
    fetch(`${API_BASE_URL}/onboard/prefill/${encodeURIComponent(token)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (!data) return;
        setState(s => ({
          ...s,
          url: data.url ?? s.url,
          vertical: data.vertical ?? s.vertical,
          goals: data.goals ?? s.goals,
          integrations: data.integrations ?? s.integrations,
        }));
      })
      .catch(() => { /* unknown token — silently ignore, use defaults */ });
  }, [state.token]);

  // Persist on every change.
  useEffect(() => { saveState(step, state); }, [step, state]);

  // Step navigation.
  const next = useCallback(() => setStep(s => Math.min(s + 1, STEPS.length - 1)), []);
  const back = useCallback(() => setStep(s => Math.max(s - 1, 0)), []);

  // Write the final profile + mark onboarded.
  const finish = useCallback(async () => {
    const profile = onboardingToBusinessProfile(state);
    try { localStorage.setItem('proplan_business_profile', JSON.stringify(profile)); } catch { /* ignore */ }
    try { localStorage.setItem(ONBOARDED_KEY, '1'); } catch { /* ignore */ }
    // Best-effort backend persist — onboarding succeeds even if the API is down.
    try {
      await fetch(`${API_BASE_URL}/profile/${encodeURIComponent(userId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...profile, user_id: userId }),
      });
    } catch { /* ignore */ }
    clearState();
    onComplete();
  }, [state, userId, onComplete]);

  const stepId = STEPS[step].id;

  return (
    <div className="pp-onboard">
      <div className="grid-bg" aria-hidden="true" />
      <div className="onboard-shell">
        <aside className="onboard-rail">
          <Brand />
          <div style={{ marginBottom: 4 }}>
            {STEPS.map((s, i) => {
              const done = i < step;
              const active = i === step;
              const className = `rail-step ${done ? 'done' : active ? 'active' : ''}`;
              const content = (
                <>
                  <div className="rail-dot">{done ? '✓' : i + 1}</div>
                  <div>
                    <div className="rail-title">{s.title}</div>
                    <div className="rail-sub">{s.sub}</div>
                  </div>
                </>
              );
              return done ? (
                <button
                  key={s.id}
                  type="button"
                  className={className}
                  onClick={() => setStep(i)}
                  aria-label={`Jump back to ${s.title}`}
                >
                  {content}
                </button>
              ) : (
                <div key={s.id} className={className}>
                  {content}
                </div>
              );
            })}
          </div>
          <div className="rail-footer">
            <strong>First Mission in 10 Minutes</strong>
            <br />
            The single commitment we make during onboarding.
            <br />
            <br />
            Nothing installs. Skip any step — come back when you're ready. We only call the tools
            you connect.
          </div>
        </aside>

        <main className="onboard-main">
          {stepId === 'url'   && <StepUrl          state={state} setState={setState} next={next} />}
          {stepId === 'verti' && <StepVertical     state={state} setState={setState} next={next} back={back} />}
          {stepId === 'goals' && <StepGoals        state={state} setState={setState} next={next} back={back} />}
          {stepId === 'integ' && <StepIntegrations state={state} setState={setState} next={next} back={back} />}
          {stepId === 'fleet' && <StepFleet        state={state} setState={setState} next={next} back={back} />}
          {stepId === 'brief' && <StepBrief        state={state} setState={setState} next={next} back={back} />}
          {stepId === 'done'  && <StepDone         state={state} onComplete={finish} />}
        </main>
      </div>
    </div>
  );
}
