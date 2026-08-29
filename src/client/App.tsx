import {useState} from 'react';

type View = 'live' | 'activity' | 'policies' | 'devices';

type Policy = {
  id: string;
  name: string;
  description: string;
  response: string;
  enabled: boolean;
  accent: string;
};

const navigation: Array<{id: View; label: string; shortLabel: string}> = [
  {id: 'live', label: 'Live door', shortLabel: 'Live'},
  {id: 'activity', label: 'Activity', shortLabel: 'Activity'},
  {id: 'policies', label: 'Policies', shortLabel: 'Policies'},
  {id: 'devices', label: 'Devices', shortLabel: 'Devices'},
];

const initialPolicies: Policy[] = [
  {
    id: 'delivery',
    name: 'Delivery drop-off',
    description: 'Thank the driver immediately and create a package summary.',
    response: 'Thanks so much — have a great day!',
    enabled: true,
    accent: 'sage',
  },
  {
    id: 'solicitor',
    name: 'Solicitors',
    description: 'Politely decline without interrupting the homeowner.',
    response: 'The household is not interested. Have a good day.',
    enabled: true,
    accent: 'clay',
  },
  {
    id: 'halloween',
    name: 'Halloween mode',
    description: 'Offer safe, upbeat comments about visible costume details.',
    response: 'A friendly greeting grounded in one privacy-minimized frame.',
    enabled: false,
    accent: 'plum',
  },
];

const deviceRows = [
  ['Raspberry Pi Zero 2 W', 'Doorstep audio and camera I/O', 'Audio conversation verified', 'online'],
  ['Jetson Orin Nano', 'Frigate perception and privacy gate', 'Frigate and edge bridge verified', 'online'],
  ['Doorman Cloud', 'Policy, agent, and event timeline', 'Workflow and Live broker deployed', 'online'],
];

function BrandMark() {
  return (
    <span aria-hidden="true" className="brand-mark">
      <span className="brand-door" />
      <span className="brand-light" />
    </span>
  );
}

function Navigation({active, onChange}: {active: View; onChange: (view: View) => void}) {
  return (
    <>
      <nav aria-label="Doorman sections" className="side-navigation">
        {navigation.map((item) => (
          <button
            aria-current={active === item.id ? 'page' : undefined}
            className="nav-button"
            key={item.id}
            onClick={() => onChange(item.id)}
            type="button"
          >
            <span aria-hidden="true" className={`nav-symbol nav-symbol-${item.id}`} />
            {item.label}
          </button>
        ))}
      </nav>

      <nav aria-label="Doorman mobile sections" className="mobile-navigation">
        {navigation.map((item) => (
          <button
            aria-current={active === item.id ? 'page' : undefined}
            className="mobile-nav-button"
            key={item.id}
            onClick={() => onChange(item.id)}
            type="button"
          >
            <span aria-hidden="true" className={`nav-symbol nav-symbol-${item.id}`} />
            {item.shortLabel}
          </button>
        ))}
      </nav>
    </>
  );
}

function PreviewFlag() {
  return (
    <div className="preview-flag" role="status">
      <span aria-hidden="true" className="preview-dot" />
      Interface preview · synthetic event
    </div>
  );
}

function LiveView() {
  return (
    <div className="view-stack">
      <section className="live-card" aria-labelledby="live-heading">
        <div className="live-visual" aria-label="Abstract front door visualization">
          <div className="porch-glow" />
          <div className="door-frame">
            <span className="door-window" />
            <span className="door-handle" />
          </div>
          <div className="doorman-orb">
            <span className="orb-eye" />
            <span className="orb-eye" />
          </div>
          <div className="visual-caption">
            <span className="soft-pulse" />
            Visual context ready
          </div>
        </div>

        <div className="live-copy">
          <div className="section-kicker">
            <span className="case-pill">DELIVERY</span>
            <span>Case D-0148</span>
          </div>
          <h1 id="live-heading">Doorman is handling this.</h1>
          <p className="live-summary">
            A delivery was detected at the front porch. The driver has been thanked,
            and the package has been added to your activity.
          </p>

          <div className="decision-strip">
            <div>
              <span className="decision-label">Decision</span>
              <strong>Thank driver automatically</strong>
            </div>
            <div>
              <span className="decision-label">Confidence</span>
              <strong>94%</strong>
            </div>
            <div>
              <span className="decision-label">Privacy</span>
              <strong>Face redacted</strong>
            </div>
          </div>

          <div className="action-row" aria-label="Manual visitor actions">
            <button className="primary-action" type="button">Send another thanks</button>
            <button className="secondary-action" type="button">Ask them to wait</button>
          </div>
        </div>
      </section>

      <div className="two-column-grid">
        <section className="content-card" aria-labelledby="conversation-heading">
          <div className="card-heading">
            <div>
              <p className="eyebrow">CURRENT INTERACTION</p>
              <h2 id="conversation-heading">At the door</h2>
            </div>
            <span className="completed-label">Completed in 8s</span>
          </div>

          <div className="conversation">
            <div className="speaker-row agent-row">
              <span className="speaker-mark">D</span>
              <div>
                <span className="speaker-name">Doorman</span>
                <p>Hi — I’m the home’s AI assistant. You can leave the package by the door.</p>
              </div>
            </div>
            <div className="speaker-row visitor-row">
              <span className="speaker-mark">V</span>
              <div>
                <span className="speaker-name">Visitor</span>
                <p>Perfect, thank you.</p>
              </div>
            </div>
            <div className="speaker-row agent-row">
              <span className="speaker-mark">D</span>
              <div>
                <span className="speaker-name">Doorman</span>
                <p>Thanks so much — have a great day!</p>
              </div>
            </div>
          </div>
        </section>

        <section className="content-card" aria-labelledby="timeline-heading">
          <div className="card-heading compact-heading">
            <div>
              <p className="eyebrow">DECISION TRACE</p>
              <h2 id="timeline-heading">What happened</h2>
            </div>
          </div>
          <ol className="timeline">
            <li>
              <span className="timeline-time">2:41:03</span>
              <div><strong>Person and package detected</strong><p>Frigate · front porch zone</p></div>
            </li>
            <li>
              <span className="timeline-time">2:41:05</span>
              <div><strong>Delivery policy applied</strong><p>Gemini observation · no identity attempted</p></div>
            </li>
            <li>
              <span className="timeline-time">2:41:08</span>
              <div><strong>Thank-you played locally</strong><p>Pi speaker · thanks-driver-v1</p></div>
            </li>
          </ol>
        </section>
      </div>
    </div>
  );
}

function ActivityView() {
  const items = [
    ['Today · 2:41 PM', 'Delivery handled', 'Driver thanked · package waiting', 'Auto'],
    ['Yesterday · 6:18 PM', 'Visitor message', 'Asked for Matthew · homeowner notified', 'Review'],
    ['Monday · 11:02 AM', 'Solicitor handled', 'Politely declined · no interruption', 'Auto'],
  ];

  return (
    <section className="page-section" aria-labelledby="activity-heading">
      <div className="page-intro">
        <p className="eyebrow">ACTIVITY</p>
        <h1 id="activity-heading">A quiet record of the doorstep.</h1>
        <p>Decision summaries are kept. Private model reasoning and visitor media are not.</p>
      </div>
      <div className="activity-list">
        {items.map(([time, title, detail, mode]) => (
          <article className="activity-item" key={time}>
            <div className="activity-time">{time}</div>
            <div className="activity-copy"><h2>{title}</h2><p>{detail}</p></div>
            <span className="mode-pill">{mode}</span>
          </article>
        ))}
      </div>
    </section>
  );
}

function PoliciesView({policies, onToggle}: {policies: Policy[]; onToggle: (id: string) => void}) {
  return (
    <section className="page-section" aria-labelledby="policies-heading">
      <div className="page-intro">
        <p className="eyebrow">HOUSE RULES</p>
        <h1 id="policies-heading">You set the boundaries. Doorman handles the moment.</h1>
        <p>These controls change only the interface preview until Firestore is connected.</p>
      </div>
      <div className="policy-grid">
        {policies.map((policy) => (
          <article className={`policy-card policy-${policy.accent}`} key={policy.id}>
            <div className="policy-topline">
              <span className="policy-icon" aria-hidden="true">
                {policy.id === 'delivery' ? '01' : policy.id === 'solicitor' ? '02' : '10/31'}
              </span>
              <button
                aria-checked={policy.enabled}
                aria-label={`${policy.enabled ? 'Disable' : 'Enable'} ${policy.name}`}
                className="switch"
                onClick={() => onToggle(policy.id)}
                role="switch"
                type="button"
              ><span /></button>
            </div>
            <h2>{policy.name}</h2>
            <p>{policy.description}</p>
            <div className="policy-response"><span>Response</span><q>{policy.response}</q></div>
          </article>
        ))}
      </div>
    </section>
  );
}

function DevicesView() {
  return (
    <section className="page-section" aria-labelledby="devices-heading">
      <div className="page-intro">
        <p className="eyebrow">SYSTEM LAYERS</p>
        <h1 id="devices-heading">From the porch to the agent.</h1>
        <p>Each layer reports its own status so a failure never looks like an empty doorstep.</p>
      </div>
      <div className="device-list">
        {deviceRows.map(([name, role, status, tone], index) => (
          <article className="device-row" key={name}>
            <span className="device-index">0{index + 1}</span>
            <div className="device-copy"><h2>{name}</h2><p>{role}</p></div>
            <span className={`device-status device-${tone}`}><span aria-hidden="true" />{status}</span>
          </article>
        ))}
      </div>
    </section>
  );
}

export function App() {
  const [activeView, setActiveView] = useState<View>('live');
  const [policies, setPolicies] = useState(initialPolicies);

  const togglePolicy = (id: string) => {
    setPolicies((current) => current.map((policy) =>
      policy.id === id ? {...policy, enabled: !policy.enabled} : policy,
    ));
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <BrandMark />
          <div><strong>Doorman</strong><span>Front-door concierge</span></div>
        </div>
        <Navigation active={activeView} onChange={setActiveView} />
        <div className="privacy-note">
          <span aria-hidden="true" className="privacy-lock">●</span>
          <div><strong>Privacy first</strong><p>Continuous video and identity stay at home.</p></div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div><span className="home-label">HOME</span><strong>Front porch</strong></div>
          <PreviewFlag />
        </header>
        {activeView === 'live' && <LiveView />}
        {activeView === 'activity' && <ActivityView />}
        {activeView === 'policies' && <PoliciesView policies={policies} onToggle={togglePolicy} />}
        {activeView === 'devices' && <DevicesView />}
      </main>
    </div>
  );
}
