/*
 * ProPlan embeddable chat widget.
 *
 * Drop-in on any site:
 *   <script>window.PROPLAN_API_URL = "https://api.proplansolutions.io";</script>
 *   <script src="https://proplansolutions.io/chat-widget.js" defer></script>
 *
 * Renders a floating bubble bottom-right. Click opens a chat panel that
 * streams Claude responses from /agent/chat/message and exposes three
 * CTAs (share contact, book a call, talk to a human).
 *
 * All styles live inside a shadow root so the host page's CSS cannot
 * bleed in — only the bubble position / z-index are applied to the host.
 */

(function () {
  if (window.__proplanChatLoaded) return;
  window.__proplanChatLoaded = true;

  var API = (window.PROPLAN_API_URL || "").replace(/\/$/, "");
  if (!API) {
    console.warn("[ProPlan chat] window.PROPLAN_API_URL not set; widget will not mount.");
    return;
  }

  var STORAGE_KEY = "proplan_chat_v1";

  var NAVY = "#0B2545";
  var ACCENT = "#1B6CA8";
  var AMBER = "#F4B942";
  var SOFT = "#E8F0F7";
  var INK = "#13304D";
  var MUTED = "#6A7C92";

  // ----------------------------- state -----------------------------
  var state = loadState() || {
    conversationId: null,
    calendlyUrl: null,
    rateLimit: 30,
    open: false,
  };
  var streaming = false;

  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }
  function saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
  }

  // ----------------------------- DOM -------------------------------
  var host = document.createElement("div");
  host.id = "proplan-chat-host";
  host.style.cssText = [
    "position:fixed",
    "right:24px",
    "bottom:24px",
    "z-index:2147483000",
    "font-family:Arial,Helvetica,sans-serif",
  ].join(";");
  document.body.appendChild(host);

  var root = host.attachShadow({ mode: "open" });

  root.innerHTML = [
    "<style>",
    ":host, * { box-sizing:border-box; }",
    ".launcher {",
    "  width:60px; height:60px; border-radius:50%;",
    "  background:" + NAVY + "; color:" + AMBER + ";",
    "  border:0; cursor:pointer;",
    "  box-shadow:0 10px 30px rgba(11,37,69,0.35);",
    "  display:flex; align-items:center; justify-content:center;",
    "  transition:transform .15s ease;",
    "}",
    ".launcher:hover { transform:scale(1.04); }",
    ".launcher svg { width:26px; height:26px; }",
    ".panel {",
    "  position:fixed; right:24px; bottom:96px;",
    "  width:380px; height:560px; max-height:calc(100vh - 120px);",
    "  background:#fff; border-radius:14px; overflow:hidden;",
    "  box-shadow:0 20px 60px rgba(11,37,69,0.35);",
    "  display:flex; flex-direction:column;",
    "  border:1px solid " + SOFT + ";",
    "  font-family:Arial,Helvetica,sans-serif;",
    "}",
    ".hdr {",
    "  background:" + NAVY + "; color:#fff; padding:14px 16px;",
    "  display:flex; align-items:center; gap:10px;",
    "}",
    ".hdr .dot { width:10px; height:10px; border-radius:50%; background:" + AMBER + "; }",
    ".hdr .title { font-weight:bold; font-size:14px; letter-spacing:.3px; }",
    ".hdr .sub { font-size:11px; color:" + SOFT + "; margin-top:2px; }",
    ".hdr .close { margin-left:auto; background:transparent; border:0; color:#fff; font-size:18px; cursor:pointer; line-height:1; padding:4px 8px; }",
    ".body { flex:1; overflow-y:auto; padding:16px; background:#fff; display:flex; flex-direction:column; gap:10px; }",
    ".msg { max-width:86%; padding:10px 12px; border-radius:12px; font-size:13px; line-height:1.45; white-space:pre-wrap; word-wrap:break-word; }",
    ".msg.user { align-self:flex-end; background:" + ACCENT + "; color:#fff; border-bottom-right-radius:4px; }",
    ".msg.bot  { align-self:flex-start; background:" + SOFT + "; color:" + INK + "; border-bottom-left-radius:4px; }",
    ".msg.tool { align-self:center; background:transparent; color:" + MUTED + "; font-size:11px; font-style:italic; padding:2px 4px; }",
    ".typing { align-self:flex-start; background:" + SOFT + "; padding:10px 14px; border-radius:12px; color:" + MUTED + "; font-size:13px; }",
    ".typing .dot { display:inline-block; width:6px; height:6px; border-radius:50%; background:" + MUTED + "; margin:0 2px; animation:blink 1.2s infinite; }",
    ".typing .dot:nth-child(2) { animation-delay:.2s; }",
    ".typing .dot:nth-child(3) { animation-delay:.4s; }",
    "@keyframes blink { 0%, 80%, 100% { opacity:.2; } 40% { opacity:1; } }",
    ".ctas { display:flex; gap:6px; padding:8px 12px; border-top:1px solid " + SOFT + "; background:#fafcfe; flex-wrap:wrap; }",
    ".cta { flex:1 1 auto; min-width:0; background:#fff; border:1px solid " + SOFT + "; color:" + INK + "; padding:8px 6px; border-radius:8px; font-size:11px; cursor:pointer; font-family:Arial,Helvetica,sans-serif; font-weight:bold; letter-spacing:.2px; }",
    ".cta:hover { border-color:" + ACCENT + "; color:" + ACCENT + "; }",
    ".form { padding:12px 16px; border-top:1px solid " + SOFT + "; background:#fafcfe; }",
    ".form .row { margin-bottom:8px; }",
    ".form label { display:block; font-size:11px; color:" + MUTED + "; margin-bottom:3px; font-weight:bold; letter-spacing:.4px; }",
    ".form input, .form textarea { width:100%; padding:8px 10px; border:1px solid " + SOFT + "; border-radius:6px; font-size:13px; font-family:Arial,Helvetica,sans-serif; color:" + INK + "; }",
    ".form textarea { resize:vertical; min-height:60px; }",
    ".form input:focus, .form textarea:focus { outline:none; border-color:" + ACCENT + "; }",
    ".form .actions { display:flex; gap:8px; margin-top:8px; }",
    ".btn-primary { flex:1; background:" + NAVY + "; color:" + AMBER + "; border:0; padding:9px 12px; border-radius:8px; font-size:12px; font-weight:bold; cursor:pointer; font-family:Arial,Helvetica,sans-serif; letter-spacing:.3px; }",
    ".btn-primary:hover { background:" + ACCENT + "; color:#fff; }",
    ".btn-ghost { background:transparent; color:" + MUTED + "; border:0; padding:9px 12px; font-size:11px; cursor:pointer; font-family:Arial,Helvetica,sans-serif; }",
    ".btn-ghost:hover { color:" + INK + "; }",
    ".compose { display:flex; gap:8px; padding:10px 12px; border-top:1px solid " + SOFT + "; background:#fff; }",
    ".compose input { flex:1; padding:10px 12px; border:1px solid " + SOFT + "; border-radius:8px; font-size:13px; font-family:Arial,Helvetica,sans-serif; color:" + INK + "; }",
    ".compose input:focus { outline:none; border-color:" + ACCENT + "; }",
    ".compose button { background:" + NAVY + "; color:" + AMBER + "; border:0; padding:0 14px; border-radius:8px; cursor:pointer; font-weight:bold; font-size:13px; font-family:Arial,Helvetica,sans-serif; }",
    ".compose button:disabled { background:" + SOFT + "; color:" + MUTED + "; cursor:not-allowed; }",
    ".err { color:#B00020; font-size:12px; padding:4px 0; }",
    ".ok  { color:#126C30; font-size:12px; padding:4px 0; }",
    ".footer { font-size:10px; color:" + MUTED + "; text-align:center; padding:6px; background:#fafcfe; border-top:1px solid " + SOFT + "; }",
    "</style>",
    '<button class="launcher" id="proplan-launcher" aria-label="Open ProPlan chat">',
    '  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">',
    '    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
    '  </svg>',
    '</button>',
    '<div class="panel" id="proplan-panel" style="display:none;">',
    '  <div class="hdr">',
    '    <span class="dot"></span>',
    '    <div>',
    '      <div class="title">ProPlan Assistant</div>',
    '      <div class="sub">Powered by Claude · usually replies in seconds</div>',
    '    </div>',
    '    <button class="close" id="proplan-close" aria-label="Close chat">×</button>',
    '  </div>',
    '  <div class="body" id="proplan-body"></div>',
    '  <div class="ctas" id="proplan-ctas">',
    '    <button class="cta" data-cta="lead">Share contact</button>',
    '    <button class="cta" data-cta="book">Book a call</button>',
    '    <button class="cta" data-cta="human">Talk to a human</button>',
    '  </div>',
    '  <div id="proplan-form-slot"></div>',
    '  <form class="compose" id="proplan-compose">',
    '    <input id="proplan-input" type="text" placeholder="Ask anything about ProPlan…" autocomplete="off" maxlength="4000"/>',
    '    <button type="submit" id="proplan-send">Send</button>',
    '  </form>',
    '  <div class="footer">We\'ll never share your info without your say-so.</div>',
    '</div>',
  ].join("");

  var launcher = root.getElementById("proplan-launcher");
  var panel = root.getElementById("proplan-panel");
  var closeBtn = root.getElementById("proplan-close");
  var body = root.getElementById("proplan-body");
  var form = root.getElementById("proplan-compose");
  var input = root.getElementById("proplan-input");
  var sendBtn = root.getElementById("proplan-send");
  var ctasEl = root.getElementById("proplan-ctas");
  var formSlot = root.getElementById("proplan-form-slot");

  // ----------------------------- helpers ---------------------------
  function h(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  function append(el) {
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
  }

  function showBot(text) {
    var m = h("div", "msg bot", text);
    append(m);
    return m;
  }

  function showUser(text) {
    append(h("div", "msg user", text));
  }

  function showTool(text) {
    append(h("div", "msg tool", text));
  }

  function showTyping() {
    var t = h("div", "typing");
    t.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
    append(t);
    return t;
  }

  // ----------------------------- boot ------------------------------
  async function ensureConversation() {
    if (state.conversationId) return state.conversationId;
    try {
      var res = await fetch(API + "/agent/chat/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          origin: window.location.origin,
          referrer: document.referrer || null,
          utm: parseUtm(),
        }),
      });
      if (!res.ok) throw new Error("start " + res.status);
      var data = await res.json();
      state.conversationId = data.conversation_id;
      state.calendlyUrl = data.calendly_url;
      state.rateLimit = data.rate_limit_per_convo;
      saveState();
      showBot(data.greeting);
      return state.conversationId;
    } catch (e) {
      showBot("Something's off on our end — please refresh and try again.");
      console.error("[ProPlan chat] start failed", e);
      return null;
    }
  }

  function parseUtm() {
    var out = {};
    try {
      var q = new URLSearchParams(window.location.search);
      ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"].forEach(function (k) {
        var v = q.get(k);
        if (v) out[k] = v;
      });
    } catch (_) {}
    return Object.keys(out).length ? out : null;
  }

  // ----------------------------- message loop ----------------------
  async function sendMessage(text) {
    if (streaming) return;
    var cid = await ensureConversation();
    if (!cid) return;

    showUser(text);
    input.value = "";
    input.disabled = true;
    sendBtn.disabled = true;
    streaming = true;

    var typing = showTyping();
    var botEl = null;
    var buf = "";

    try {
      var resp = await fetch(API + "/agent/chat/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: cid, message: text }),
      });
      if (!resp.ok) {
        var errText = "Message failed (" + resp.status + ").";
        try {
          var errJson = await resp.json();
          if (errJson && errJson.detail) errText = errJson.detail;
        } catch (_) {}
        typing.remove();
        showBot(errText);
        return;
      }

      var reader = resp.body.getReader();
      var decoder = new TextDecoder();
      var textBuf = "";

      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        textBuf += decoder.decode(chunk.value, { stream: true });

        var lines = textBuf.split("\n\n");
        textBuf = lines.pop(); // keep trailing partial frame

        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (!line.startsWith("data:")) continue;
          var payload;
          try { payload = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }

          if (payload.type === "token") {
            if (!botEl) {
              typing.remove();
              botEl = showBot("");
            }
            buf += payload.text;
            botEl.textContent = buf;
            body.scrollTop = body.scrollHeight;
          } else if (payload.type === "error") {
            if (!botEl) { typing.remove(); botEl = showBot(""); }
            botEl.textContent = buf + " (stream cut short — please try again.)";
          } else if (payload.type === "done") {
            if (!botEl) { typing.remove(); showBot("(no reply)"); }
          }
        }
      }
    } catch (e) {
      typing.remove();
      showBot("Connection dropped. Refresh and try again.");
      console.error("[ProPlan chat] stream error", e);
    } finally {
      input.disabled = false;
      sendBtn.disabled = false;
      streaming = false;
      input.focus();
    }
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var t = input.value.trim();
    if (!t) return;
    sendMessage(t);
  });

  // ----------------------------- CTAs ------------------------------
  ctasEl.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-cta]");
    if (!btn) return;
    var kind = btn.getAttribute("data-cta");
    if (kind === "lead") renderLeadForm();
    if (kind === "book") renderBookForm();
    if (kind === "human") renderEscalateForm();
  });

  function clearForm() {
    formSlot.innerHTML = "";
  }

  function renderLeadForm() {
    clearForm();
    var wrap = h("div", "form");
    wrap.innerHTML = [
      '<div class="row"><label>Your name</label><input name="name" required/></div>',
      '<div class="row"><label>Email</label><input name="email" type="email" required/></div>',
      '<div class="row"><label>Company (optional)</label><input name="company"/></div>',
      '<div class="row"><label>What would help you most?</label><textarea name="notes" rows="2"></textarea></div>',
      '<div class="actions"><button class="btn-primary" data-action="submit">Send</button><button type="button" class="btn-ghost" data-action="cancel">Cancel</button></div>',
      '<div class="err" data-slot="err" style="display:none;"></div>',
    ].join("");
    formSlot.appendChild(wrap);

    wrap.querySelector('[data-action="cancel"]').onclick = clearForm;
    wrap.querySelector('[data-action="submit"]').onclick = async function () {
      var cid = await ensureConversation();
      if (!cid) return;
      var payload = {
        conversation_id: cid,
        full_name: wrap.querySelector('[name=name]').value.trim(),
        email: wrap.querySelector('[name=email]').value.trim(),
        company_name: wrap.querySelector('[name=company]').value.trim() || null,
        notes: wrap.querySelector('[name=notes]').value.trim() || null,
      };
      if (!payload.full_name || !payload.email) {
        showError(wrap, "Name and email are required.");
        return;
      }
      try {
        var res = await fetch(API + "/agent/chat/capture_lead", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(await res.text());
        clearForm();
        showTool("Contact shared — the team will follow up.");
      } catch (e) {
        showError(wrap, "Couldn't save — please try again.");
      }
    };
  }

  function renderBookForm() {
    clearForm();
    var wrap = h("div", "form");
    wrap.innerHTML = [
      '<div class="row"><label>Your name</label><input name="name" required/></div>',
      '<div class="row"><label>Email</label><input name="email" type="email" required/></div>',
      '<div class="row"><label>Company (optional)</label><input name="company"/></div>',
      '<div class="row"><label>What do you want to cover?</label><textarea name="notes" rows="2"></textarea></div>',
      '<div class="actions"><button class="btn-primary" data-action="submit">Pick a time</button><button type="button" class="btn-ghost" data-action="cancel">Cancel</button></div>',
      '<div class="err" data-slot="err" style="display:none;"></div>',
    ].join("");
    formSlot.appendChild(wrap);

    wrap.querySelector('[data-action="cancel"]').onclick = clearForm;
    wrap.querySelector('[data-action="submit"]').onclick = async function () {
      var cid = await ensureConversation();
      if (!cid) return;
      var payload = {
        conversation_id: cid,
        full_name: wrap.querySelector('[name=name]').value.trim(),
        email: wrap.querySelector('[name=email]').value.trim(),
        company_name: wrap.querySelector('[name=company]').value.trim() || null,
        notes: wrap.querySelector('[name=notes]').value.trim() || null,
      };
      if (!payload.full_name || !payload.email) {
        showError(wrap, "Name and email are required.");
        return;
      }
      try {
        var res = await fetch(API + "/agent/chat/book_call", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(await res.text());
        var data = await res.json();
        clearForm();
        showTool("Opening the team calendar in a new tab…");
        window.open(data.calendly_url, "_blank", "noopener");
      } catch (e) {
        showError(wrap, "Couldn't open the calendar — please try again.");
      }
    };
  }

  function renderEscalateForm() {
    clearForm();
    var wrap = h("div", "form");
    wrap.innerHTML = [
      '<div class="row"><label>What do you need help with?</label><textarea name="reason" rows="2" required></textarea></div>',
      '<div class="row"><label>How should we reach you? (email or phone)</label><input name="contact"/></div>',
      '<div class="actions"><button class="btn-primary" data-action="submit">Send to human</button><button type="button" class="btn-ghost" data-action="cancel">Cancel</button></div>',
      '<div class="err" data-slot="err" style="display:none;"></div>',
    ].join("");
    formSlot.appendChild(wrap);

    wrap.querySelector('[data-action="cancel"]').onclick = clearForm;
    wrap.querySelector('[data-action="submit"]').onclick = async function () {
      var cid = await ensureConversation();
      if (!cid) return;
      var reason = wrap.querySelector('[name=reason]').value.trim();
      var contact = wrap.querySelector('[name=contact]').value.trim() || null;
      if (!reason) {
        showError(wrap, "Please tell us a bit about what you need.");
        return;
      }
      try {
        var res = await fetch(API + "/agent/chat/escalate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversation_id: cid, reason: reason, contact: contact }),
        });
        if (!res.ok) throw new Error(await res.text());
        clearForm();
        showTool("Routed to a human — we'll reply shortly.");
      } catch (e) {
        showError(wrap, "Couldn't reach the team — please try again.");
      }
    };
  }

  function showError(wrap, text) {
    var s = wrap.querySelector('[data-slot="err"]');
    s.textContent = text;
    s.style.display = "block";
  }

  // ----------------------------- open/close ------------------------
  async function openPanel() {
    panel.style.display = "flex";
    launcher.style.display = "none";
    state.open = true;
    saveState();
    if (!body.childElementCount) await ensureConversation();
    setTimeout(function () { input.focus(); }, 10);
  }

  function closePanel() {
    panel.style.display = "none";
    launcher.style.display = "flex";
    state.open = false;
    saveState();
  }

  launcher.addEventListener("click", openPanel);
  closeBtn.addEventListener("click", closePanel);

  if (state.open) openPanel();
})();
