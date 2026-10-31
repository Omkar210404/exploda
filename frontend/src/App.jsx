import { useEffect, useState } from 'react';
import Viewer from './Viewer.jsx';
import Chat from './Chat.jsx';

const MODELS = `${import.meta.env.BASE_URL}models/`;

function load(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage blocked */ }
}

export default function App() {
  const [manifest, setManifest] = useState(null);
  const [error, setError] = useState('');
  const [model, setModel] = useState(null);
  const [parts, setParts] = useState(null);
  const [hovered, setHovered] = useState(null);
  const [selected, setSelected] = useState(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [threads, setThreads] = useState({});
  const [theme, setTheme] = useState(() => load('exploda-theme', 'dark'));
  const [drawer, setDrawer] = useState(false);
  const [explode, setExplode] = useState(0);
  const [hotspots, setHotspots] = useState(true);
  const [xray, setXray] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    save('exploda-theme', theme);
  }, [theme]);

  useEffect(() => {
    fetch(`${MODELS}manifest.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`manifest ${r.status}`))))
      .then((m) => {
        setManifest(m);
        const first = m.categories.flatMap((c) => c.models).find((x) => !x.comingSoon);
        if (first) openModel(first);
      })
      .catch((e) => setError(`Could not load the model library (${e.message}).`));
  }, []);

  function openModel(m) {
    setModel(m); setParts(null); setSelected(null); setHovered(null); setChatOpen(false); setExplode(0); setXray(false); setDrawer(false);
    fetch(`${MODELS}${m.folder}/${m.parts}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
      .then(setParts)
      .catch(() => setParts({}));
  }

  const category = manifest?.categories.find((c) => c.models.includes(model));
  const partIds = parts ? Object.keys(parts) : [];
  const threadKey = model && selected ? `${model.id}/${selected}` : null;

  return (
    <div className={`app ${chatOpen && selected ? 'chat-open' : ''}`}>
      <aside className={`sidebar glass ${drawer ? 'open' : ''}`}>
        <div className="brand">
          <span className="logo" aria-hidden="true"><i /></span>
          <div>
            <h1>Exploda</h1>
            <p>Interactive 3D learning</p>
          </div>
          <button className="icon-btn only-mobile" onClick={() => setDrawer(false)} aria-label="Close library">✕</button>
        </div>

        <div className="sidebar-scroll">
          <h2 className="section-label">Library</h2>
          {error && <div className="state error">{error}</div>}
          {!manifest && !error && <div className="state"><span className="spinner" /> Loading library…</div>}
          {manifest?.categories.map((c) => (
            <section key={c.id} className="category">
              <h3>{c.name}<span>{c.models.filter((m) => !m.comingSoon).length}</span></h3>
              {c.models.map((m) => m.comingSoon ? (
                <div key={m.id} className="card soon">
                  <strong>{m.name}</strong>
                  <small>{m.description}</small>
                </div>
              ) : (
                <button key={m.id} className={`card ${m === model ? 'active' : ''}`} onClick={() => openModel(m)}>
                  <strong>{m.name}</strong>
                  <small>{m.description}</small>
                </button>
              ))}
            </section>
          ))}

          {model && (
            <>
              <h2 className="section-label">Parts {parts && <span>{partIds.length}</span>}</h2>
              {!parts && <div className="state"><span className="spinner" /> Loading parts…</div>}
              {parts && partIds.length === 0 && <div className="state error">No parts data found for this model.</div>}
              <ul className="parts">
                {partIds.map((id) => (
                  <li key={id}>
                    <button
                      className={`${id === selected ? 'active' : ''} ${id === hovered ? 'hover' : ''}`}
                      onClick={() => setSelected(id === selected ? null : id)}
                      onMouseEnter={() => setHovered(id)}
                      onMouseLeave={() => setHovered(null)}
                    >
                      <i />{parts[id].name}
                    </button>
                  </li>
                ))}
              </ul>
              {model.credit && (
                <p className="credit">
                  Source: {model.credit.url ? <a href={model.credit.url} target="_blank" rel="noreferrer">{model.credit.author}</a> : model.credit.author} · {model.credit.license}
                </p>
              )}
            </>
          )}
        </div>
      </aside>
      {drawer && <div className="scrim only-mobile" onClick={() => setDrawer(false)} />}

      <main className="stage">
        <header className="toolbar">
          <button className="icon-btn only-mobile" onClick={() => setDrawer(true)} aria-label="Open library">☰</button>
          <div className="crumbs">
            <span>{category?.name ?? 'Library'}</span>
            <strong>{model?.name ?? '—'}</strong>
          </div>
          <div className="tools glass">
            <label className="explode" title="Pull the parts apart">
              <span>Explode</span>
              <input type="range" min="0" max="1" step="0.01" value={explode} onChange={(e) => setExplode(+e.target.value)} />
            </label>
            {partIds.some((id) => parts[id].shell) && (
              <button className={`chip ${xray ? 'on' : ''}`} onClick={() => setXray(!xray)} title="See through the outer parts">X-ray</button>
            )}
            <button className={`chip ${hotspots ? 'on' : ''}`} onClick={() => setHotspots(!hotspots)}>Hotspots</button>
            <button className="icon-btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="Toggle theme">
              {theme === 'dark' ? '☀' : '☾'}
            </button>
          </div>
        </header>

        {model && parts ? (
          <Viewer
            key={model.id}
            url={`${MODELS}${model.folder}/${model.file}`}
            parts={parts}
            hovered={hovered}
            selected={selected}
            onHover={setHovered}
            onSelect={setSelected}
            onMoreInfo={() => setChatOpen(true)}
            explode={explode}
            hotspots={hotspots}
            xray={xray}
            stage={model.stage}
          />
        ) : (
          <div className="state center">{error ? 'Nothing to show yet.' : <><span className="spinner" /> Preparing stage…</>}</div>
        )}
        <p className="hint">Drag to orbit · scroll to zoom · right-drag to pan · click a part</p>
      </main>

      {chatOpen && selected && parts?.[selected] && (
        <Chat
          key={threadKey}
          modelId={model.id}
          modelName={model.name}
          partId={selected}
          part={parts[selected]}
          thread={threads[threadKey] ?? []}
          setThread={(fn) => setThreads((t) => ({ ...t, [threadKey]: fn(t[threadKey] ?? []) }))}
          onClose={() => setChatOpen(false)}
        />
      )}
    </div>
  );
}
