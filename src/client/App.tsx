const layers = [
  ['Pi Zero 2 W', 'Doorstep audio and camera I/O'],
  ['Jetson Orin Nano', 'Local Frigate perception and privacy gate'],
  ['Doorman Agent', 'Policy-bound Gemini interaction'],
];

export function App() {
  return (
    <main className="shell">
      <header className="hero">
        <p className="eyebrow">DOORMAN / LOCAL PROTOTYPE</p>
        <h1>The front door can handle the first hello.</h1>
        <p className="lede">
          A privacy-first AI concierge that understands the immediate context,
          handles routine visitors, and involves you only when needed.
        </p>
      </header>

      <section aria-labelledby="system-title" className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">SYSTEM</p>
            <h2 id="system-title">Waiting at the door</h2>
          </div>
          <span className="status">Local systems pending</span>
        </div>

        <div className="layer-grid">
          {layers.map(([name, role]) => (
            <article className="layer" key={name}>
              <span aria-hidden="true" className="layer-dot" />
              <h3>{name}</h3>
              <p>{role}</p>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

