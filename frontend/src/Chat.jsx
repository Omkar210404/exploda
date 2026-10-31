import { useEffect, useRef, useState } from 'react';

const SUGGESTIONS = ['What does it do?', 'Give me the key facts', 'What is it connected to?'];
const STYLES = [['simple', 'Simple'], ['standard', 'Normal'], ['technical', 'Technical']];
const DEMO = import.meta.env.VITE_DEMO === '1'; // GitHub Pages build: no backend

// one status check shared by every part's panel; retried if it failed
let statusCheck = null;
function getStatus() {
  if (DEMO) return Promise.resolve({ demo: true });
  statusCheck ??= fetch('/api/status')
    .then((r) => r.json())
    .catch(() => ({ offline: true }))
    .then((s) => { if (!s.configured) statusCheck = null; return s; });
  return statusCheck;
}

function loadStyle() {
  try { return localStorage.getItem('exploda-style') || 'standard'; } catch { return 'standard'; }
}

export default function Chat({ modelId, modelName, partId, part, thread, setThread, onClose }) {
  const [status, setStatus] = useState(null); // {configured, provider, detail} | {offline} | {demo}
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [style, setStyle] = useState(loadStyle);
  const end = useRef(null);

  useEffect(() => { getStatus().then(setStatus); }, []);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [thread]);
  useEffect(() => { try { localStorage.setItem('exploda-style', style); } catch { /* storage blocked */ } }, [style]);

  async function ask(text) {
    const q = text.trim();
    if (!q || busy) return;
    setInput('');
    setBusy(true);
    const history = [...thread, { role: 'user', content: q }];
    setThread(() => [...history, { role: 'assistant', content: '' }]);
    const append = (chunk, extra = {}) => setThread((t) => {
      const last = t[t.length - 1];
      return [...t.slice(0, -1), { ...last, content: last.content + chunk, ...extra }];
    });
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model_id: modelId, part_id: partId, style, messages: history.filter((m) => m.content && !m.error) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        append(dec.decode(value, { stream: true }));
      }
    } catch (e) {
      append('', { error: e.message || 'Something went wrong.' });
    } finally {
      setBusy(false);
    }
  }

  const ready = status?.configured;

  return (
    <aside className="chat glass">
      <header>
        <div>
          <small>{modelName}</small>
          <h2>{part.name}</h2>
        </div>
        <div className="chat-actions">
          {thread.length > 0 && !busy && <button className="chip" onClick={() => setThread(() => [])}>Clear</button>}
          <button className="icon-btn" onClick={onClose} aria-label="Close chat">✕</button>
        </div>
      </header>

      <details className="grounding" open={thread.length === 0}>
        <summary>What the AI knows about this part</summary>
        <p>{part.description}</p>
        <ul>{part.facts.map((f) => <li key={f}>{f}</li>)}</ul>
      </details>

      <div className="messages">
        {status === null && <div className="state"><span className="spinner" /> Checking AI…</div>}
        {status?.demo && (
          <div className="state">This online demo has no AI backend, so chat is off. Run Exploda locally (free with Ollama) to ask questions. The notes above are what the AI would answer from.</div>
        )}
        {status?.offline && <div className="state error">AI backend is offline. Start it with <code>uvicorn app:app</code> in <code>backend/</code>.</div>}
        {status && !status.offline && !status.demo && !ready && (
          <div className="state error"><strong>AI not configured.</strong> {status.detail}</div>
        )}
        {ready && thread.length === 0 && (
          <div className="state">Ask anything about the {part.name.toLowerCase()}. Answers come only from the notes above.</div>
        )}
        {thread.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.content || (m.error ? '' : <span className="typing"><i /><i /><i /></span>)}
            {m.error && <span className="msg-error">{m.error}</span>}
          </div>
        ))}
        <div ref={end} />
      </div>

      {ready && thread.length === 0 && (
        <div className="suggestions">
          {SUGGESTIONS.map((s) => <button key={s} className="chip" onClick={() => ask(s)}>{s}</button>)}
        </div>
      )}

      {ready && (
        <div className="styles" role="radiogroup" aria-label="Answer style">
          {STYLES.map(([id, label]) => (
            <button key={id} role="radio" aria-checked={style === id} className={style === id ? 'on' : ''} onClick={() => setStyle(id)}>{label}</button>
          ))}
        </div>
      )}

      <form onSubmit={(e) => { e.preventDefault(); ask(input); }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={ready ? `Ask about the ${part.name.toLowerCase()}…` : 'AI not available'}
          disabled={!ready || busy}
          maxLength={1000}
        />
        <button className="send" disabled={!ready || busy || !input.trim()}>{busy ? '…' : 'Ask'}</button>
      </form>
      {ready && <p className="provider">via {status.provider}{status.model ? ` · ${status.model}` : ''}</p>}
    </aside>
  );
}
