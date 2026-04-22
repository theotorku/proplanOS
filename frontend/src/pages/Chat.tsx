/*
 * Shareable /chat page — navy/amber branded single-pane chat for
 * partners who don't want to embed the widget.
 *
 * Talks to the same /agent/chat/* endpoints as the embeddable widget.
 * Styles are inline so this page stays independent of the operator
 * console's tokens (index.css).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

type Role = 'user' | 'bot' | 'tool';
type ChatItem = { id: string; role: Role; text: string };

type CtaKind = 'lead' | 'book' | 'human' | null;

const API_BASE_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:8000').replace(/\/$/, '');
const STORAGE_KEY = 'proplan_chat_v1';

const COLOR = {
  navy: '#0B2545',
  accent: '#1B6CA8',
  amber: '#F4B942',
  soft: '#E8F0F7',
  ink: '#13304D',
  muted: '#6A7C92',
};

function loadStored(): { conversationId: string | null; calendlyUrl: string | null; rateLimit: number } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { conversationId: null, calendlyUrl: null, rateLimit: 30 };
    const p = JSON.parse(raw);
    return {
      conversationId: p.conversationId ?? null,
      calendlyUrl: p.calendlyUrl ?? null,
      rateLimit: p.rateLimit ?? 30,
    };
  } catch {
    return { conversationId: null, calendlyUrl: null, rateLimit: 30 };
  }
}

function saveStored(next: { conversationId: string | null; calendlyUrl: string | null; rateLimit: number }) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...next, open: true }));
  } catch { /* noop */ }
}

function parseUtm(): Record<string, string> | null {
  const out: Record<string, string> = {};
  try {
    const q = new URLSearchParams(window.location.search);
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach(k => {
      const v = q.get(k);
      if (v) out[k] = v;
    });
  } catch { /* noop */ }
  return Object.keys(out).length ? out : null;
}

export default function ChatPage() {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [cta, setCta] = useState<CtaKind>(null);
  const [error, setError] = useState<string | null>(null);

  const bootedRef = useRef(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const convoRef = useRef<string | null>(loadStored().conversationId);
  const calendlyRef = useRef<string | null>(loadStored().calendlyUrl);

  const pushItem = useCallback((item: ChatItem) => {
    setItems(prev => [...prev, item]);
  }, []);

  const ensureConversation = useCallback(async (): Promise<string | null> => {
    if (convoRef.current) return convoRef.current;
    try {
      const res = await fetch(`${API_BASE_URL}/agent/chat/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          origin: window.location.origin,
          referrer: document.referrer || null,
          utm: parseUtm(),
        }),
      });
      if (!res.ok) throw new Error(`start ${res.status}`);
      const data = await res.json();
      convoRef.current = data.conversation_id;
      calendlyRef.current = data.calendly_url;
      saveStored({
        conversationId: data.conversation_id,
        calendlyUrl: data.calendly_url,
        rateLimit: data.rate_limit_per_convo ?? 30,
      });
      pushItem({ id: crypto.randomUUID(), role: 'bot', text: data.greeting });
      return data.conversation_id;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start conversation.');
      return null;
    }
  }, [pushItem]);

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    ensureConversation();
  }, [ensureConversation]);

  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight, behavior: 'smooth' });
  }, [items]);

  const sendMessage = useCallback(async (text: string) => {
    if (streaming) return;
    const cid = await ensureConversation();
    if (!cid) return;

    pushItem({ id: crypto.randomUUID(), role: 'user', text });
    setInput('');
    setStreaming(true);
    setError(null);

    const botId = crypto.randomUUID();
    let botBuf = '';
    let botStarted = false;

    try {
      const resp = await fetch(`${API_BASE_URL}/agent/chat/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: cid, message: text }),
      });

      if (!resp.ok) {
        let detail = `Message failed (HTTP ${resp.status}).`;
        try {
          const j = await resp.json();
          if (j?.detail) detail = j.detail;
        } catch { /* keep default */ }
        pushItem({ id: botId, role: 'bot', text: detail });
        return;
      }

      const reader = resp.body?.getReader();
      if (!reader) throw new Error('Streaming body unavailable.');
      const decoder = new TextDecoder();
      let frameBuf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        frameBuf += decoder.decode(value, { stream: true });

        const frames = frameBuf.split('\n\n');
        frameBuf = frames.pop() ?? '';

        for (const raw of frames) {
          const line = raw.trim();
          if (!line.startsWith('data:')) continue;
          let payload: { type?: string; text?: string; message?: string } = {};
          try { payload = JSON.parse(line.slice(5).trim()); } catch { continue; }

          if (payload.type === 'token' && typeof payload.text === 'string') {
            if (!botStarted) {
              botStarted = true;
              pushItem({ id: botId, role: 'bot', text: '' });
            }
            botBuf += payload.text;
            setItems(prev => prev.map(it => it.id === botId ? { ...it, text: botBuf } : it));
          } else if (payload.type === 'error') {
            if (!botStarted) pushItem({ id: botId, role: 'bot', text: '(stream error — try again.)' });
          } else if (payload.type === 'done') {
            if (!botStarted) pushItem({ id: botId, role: 'bot', text: '(no reply)' });
          }
        }
      }
    } catch (e) {
      pushItem({ id: botId, role: 'bot', text: 'Connection dropped. Refresh and try again.' });
      console.error('[ProPlan chat] stream error', e);
    } finally {
      setStreaming(false);
    }
  }, [ensureConversation, pushItem, streaming]);

  const submitLead = useCallback(async (form: LeadForm) => {
    const cid = await ensureConversation();
    if (!cid) return false;
    const res = await fetch(`${API_BASE_URL}/agent/chat/capture_lead`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: cid, ...form }),
    });
    if (!res.ok) return false;
    pushItem({ id: crypto.randomUUID(), role: 'tool', text: 'Contact shared — the team will follow up.' });
    return true;
  }, [ensureConversation, pushItem]);

  const submitBook = useCallback(async (form: LeadForm): Promise<string | null> => {
    const cid = await ensureConversation();
    if (!cid) return null;
    const res = await fetch(`${API_BASE_URL}/agent/chat/book_call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: cid, ...form }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    pushItem({ id: crypto.randomUUID(), role: 'tool', text: 'Opening the team calendar…' });
    return data.calendly_url as string;
  }, [ensureConversation, pushItem]);

  const submitEscalate = useCallback(async (reason: string, contact: string | null) => {
    const cid = await ensureConversation();
    if (!cid) return false;
    const res = await fetch(`${API_BASE_URL}/agent/chat/escalate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: cid, reason, contact }),
    });
    if (!res.ok) return false;
    pushItem({ id: crypto.randomUUID(), role: 'tool', text: "Routed to a human — we'll reply shortly." });
    return true;
  }, [ensureConversation, pushItem]);

  return (
    <div style={{
      minHeight: '100vh',
      background: `linear-gradient(180deg, ${COLOR.soft} 0%, #fff 100%)`,
      fontFamily: 'Arial, Helvetica, sans-serif',
      color: COLOR.ink,
      display: 'flex', flexDirection: 'column', alignItems: 'center',
    }}>
      <header style={{
        width: '100%', background: COLOR.navy, color: '#fff',
        padding: '18px 24px', display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <span style={{ width: 10, height: 10, borderRadius: 5, background: COLOR.amber }} />
        <div>
          <div style={{ fontWeight: 700, fontSize: 16, letterSpacing: 0.4 }}>ProPlan Assistant</div>
          <div style={{ fontSize: 12, color: COLOR.soft }}>Ask anything about our AI agent OS. Powered by Claude.</div>
        </div>
      </header>

      <main style={{
        flex: 1, width: '100%', maxWidth: 760,
        display: 'flex', flexDirection: 'column',
        padding: '16px', gap: 12,
      }}>
        <div
          ref={scrollerRef}
          style={{
            flex: 1, minHeight: 360,
            background: '#fff', borderRadius: 14, border: `1px solid ${COLOR.soft}`,
            padding: 18, overflowY: 'auto',
            display: 'flex', flexDirection: 'column', gap: 10,
            boxShadow: '0 8px 24px rgba(11,37,69,0.06)',
          }}
        >
          {items.map(it => (
            <Bubble key={it.id} role={it.role} text={it.text} />
          ))}
          {streaming && <TypingDots />}
          {error && <div style={{ color: '#B00020', fontSize: 13 }}>{error}</div>}
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <CtaButton active={cta === 'lead'}  onClick={() => setCta(cta === 'lead' ? null : 'lead')}>Share contact</CtaButton>
          <CtaButton active={cta === 'book'}  onClick={() => setCta(cta === 'book' ? null : 'book')}>Book a call</CtaButton>
          <CtaButton active={cta === 'human'} onClick={() => setCta(cta === 'human' ? null : 'human')}>Talk to a human</CtaButton>
        </div>

        {cta === 'lead' && (
          <ContactForm
            cta="share"
            onCancel={() => setCta(null)}
            onSubmit={async f => { const ok = await submitLead(f); if (ok) setCta(null); return ok; }}
          />
        )}
        {cta === 'book' && (
          <ContactForm
            cta="book"
            onCancel={() => setCta(null)}
            onSubmit={async f => {
              const url = await submitBook(f);
              if (url) {
                window.open(url, '_blank', 'noopener');
                setCta(null);
                return true;
              }
              return false;
            }}
          />
        )}
        {cta === 'human' && (
          <EscalateForm onCancel={() => setCta(null)} onSubmit={async (r, c) => { const ok = await submitEscalate(r, c); if (ok) setCta(null); return ok; }} />
        )}

        <form
          onSubmit={e => { e.preventDefault(); const t = input.trim(); if (t) sendMessage(t); }}
          style={{ display: 'flex', gap: 8 }}
        >
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Ask anything about ProPlan…"
            disabled={streaming}
            maxLength={4000}
            style={{
              flex: 1, padding: '11px 14px', borderRadius: 10,
              border: `1px solid ${COLOR.soft}`, fontSize: 14,
              fontFamily: 'Arial, Helvetica, sans-serif', color: COLOR.ink,
              outline: 'none',
            }}
          />
          <button
            type="submit"
            disabled={streaming || !input.trim()}
            style={{
              background: COLOR.navy, color: COLOR.amber, border: 0,
              padding: '0 18px', borderRadius: 10, fontWeight: 700, fontSize: 14,
              cursor: streaming ? 'not-allowed' : 'pointer',
              opacity: streaming ? 0.6 : 1,
            }}
          >Send</button>
        </form>

        <p style={{ fontSize: 11, color: COLOR.muted, textAlign: 'center', margin: 0 }}>
          Your conversation stays private. We'll only reach out if you ask us to.
        </p>
      </main>
    </div>
  );
}

function Bubble({ role, text }: { role: Role; text: string }) {
  const user = role === 'user';
  const tool = role === 'tool';
  return (
    <div
      style={{
        alignSelf: user ? 'flex-end' : tool ? 'center' : 'flex-start',
        maxWidth: tool ? '100%' : '82%',
        padding: tool ? '2px 4px' : '10px 14px',
        borderRadius: 12,
        background: user ? COLOR.accent : tool ? 'transparent' : COLOR.soft,
        color: user ? '#fff' : tool ? COLOR.muted : COLOR.ink,
        fontSize: tool ? 11 : 14,
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        fontStyle: tool ? 'italic' : 'normal',
        borderBottomRightRadius: user ? 4 : 12,
        borderBottomLeftRadius: (!user && !tool) ? 4 : 12,
      }}
    >
      {text}
    </div>
  );
}

function TypingDots() {
  return (
    <div style={{
      alignSelf: 'flex-start',
      background: COLOR.soft,
      padding: '8px 14px',
      borderRadius: 12,
      color: COLOR.muted,
      fontSize: 18,
      letterSpacing: 2,
    }}>
      …
    </div>
  );
}

function CtaButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: '1 1 auto', minWidth: 0,
        background: active ? COLOR.accent : '#fff',
        color: active ? '#fff' : COLOR.ink,
        border: `1px solid ${active ? COLOR.accent : COLOR.soft}`,
        padding: '10px 12px', borderRadius: 10,
        fontSize: 13, fontWeight: 700, cursor: 'pointer',
        fontFamily: 'Arial, Helvetica, sans-serif',
      }}
    >
      {children}
    </button>
  );
}

type LeadForm = { full_name: string; email: string; company_name: string | null; notes: string | null };

function ContactForm({
  cta, onSubmit, onCancel,
}: {
  cta: 'share' | 'book';
  onSubmit: (f: LeadForm) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    if (!name.trim() || !email.trim()) { setErr('Name and email are required.'); return; }
    setBusy(true);
    const ok = await onSubmit({
      full_name: name.trim(),
      email: email.trim(),
      company_name: company.trim() || null,
      notes: notes.trim() || null,
    });
    setBusy(false);
    if (!ok) setErr('Submission failed — please try again.');
  };

  return (
    <div style={{
      background: '#fff', border: `1px solid ${COLOR.soft}`,
      borderRadius: 12, padding: 14,
    }}>
      <Field label="Your name"><input style={fieldStyle} value={name} onChange={e => setName(e.target.value)} /></Field>
      <Field label="Email"><input style={fieldStyle} value={email} onChange={e => setEmail(e.target.value)} type="email" /></Field>
      <Field label="Company (optional)"><input style={fieldStyle} value={company} onChange={e => setCompany(e.target.value)} /></Field>
      <Field label={cta === 'share' ? 'What would help you most?' : 'What do you want to cover?'}>
        <textarea style={{ ...fieldStyle, minHeight: 60, resize: 'vertical' }} value={notes} onChange={e => setNotes(e.target.value)} rows={2} />
      </Field>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button onClick={submit} disabled={busy} style={primaryBtn}>{cta === 'share' ? (busy ? 'Sending…' : 'Send') : (busy ? 'Opening…' : 'Pick a time')}</button>
        <button onClick={onCancel} disabled={busy} style={ghostBtn}>Cancel</button>
      </div>
      {err && <div style={{ color: '#B00020', fontSize: 12, marginTop: 6 }}>{err}</div>}
    </div>
  );
}

function EscalateForm({
  onSubmit, onCancel,
}: {
  onSubmit: (reason: string, contact: string | null) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const [contact, setContact] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    if (!reason.trim()) { setErr('Please tell us a bit about what you need.'); return; }
    setBusy(true);
    const ok = await onSubmit(reason.trim(), contact.trim() || null);
    setBusy(false);
    if (!ok) setErr('Could not reach the team — please try again.');
  };

  return (
    <div style={{
      background: '#fff', border: `1px solid ${COLOR.soft}`,
      borderRadius: 12, padding: 14,
    }}>
      <Field label="What do you need help with?">
        <textarea style={{ ...fieldStyle, minHeight: 70, resize: 'vertical' }} value={reason} onChange={e => setReason(e.target.value)} rows={3} />
      </Field>
      <Field label="How should we reach you? (email or phone, optional)">
        <input style={fieldStyle} value={contact} onChange={e => setContact(e.target.value)} />
      </Field>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button onClick={submit} disabled={busy} style={primaryBtn}>{busy ? 'Routing…' : 'Send to human'}</button>
        <button onClick={onCancel} disabled={busy} style={ghostBtn}>Cancel</button>
      </div>
      {err && <div style={{ color: '#B00020', fontSize: 12, marginTop: 6 }}>{err}</div>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 11, color: COLOR.muted, fontWeight: 700, letterSpacing: 0.4, marginBottom: 3 }}>{label}</div>
      {children}
    </div>
  );
}

const fieldStyle: CSSProperties = {
  width: '100%',
  padding: '9px 11px',
  border: `1px solid ${COLOR.soft}`,
  borderRadius: 8,
  fontSize: 13,
  fontFamily: 'Arial, Helvetica, sans-serif',
  color: COLOR.ink,
  outline: 'none',
};

const primaryBtn: CSSProperties = {
  flex: 1,
  background: COLOR.navy,
  color: COLOR.amber,
  border: 0,
  padding: '10px 14px',
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 700,
  cursor: 'pointer',
  fontFamily: 'Arial, Helvetica, sans-serif',
};

const ghostBtn: CSSProperties = {
  background: 'transparent',
  color: COLOR.muted,
  border: 0,
  padding: '10px 12px',
  fontSize: 12,
  cursor: 'pointer',
  fontFamily: 'Arial, Helvetica, sans-serif',
};
