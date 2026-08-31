import {useCallback, useEffect, useMemo, useState} from 'react';

type View = 'live' | 'activity' | 'policies' | 'devices';
type Urgency = 'routine' | 'important' | 'urgent';

type VisitorReport = {
  intent: 'property_issue' | 'resident_request' | 'delivery' | 'message' | 'other';
  visitor_claimed_name: string | null;
  relationship_claim: string | null;
  message: string;
  location_detail: string | null;
  urgency: Urgency;
  confidence: number;
};

type TimelineEntry = {
  id: string;
  occurred_at: string;
  layer: 'edge' | 'workflow' | 'agent' | 'command';
  type: string;
  summary: string;
};

type InteractionCase = {
  case_id: string;
  source_event_id: string;
  created_at: string;
  updated_at: string;
  status: 'active' | 'waiting' | 'completed' | 'review';
  visitor_report: VisitorReport | null;
  decision: {
    classification: string;
    decision_summary: string;
    confidence: number;
  };
  timeline: TimelineEntry[];
};

type Policy = {
  id: string;
  name: string;
  enabled: boolean;
  minimum_confidence: number;
  response_text: string;
};

type ApiStatus = {
  mode: string;
  agent_mode: string;
  cases: number;
  enabled_policies: number;
  integrations: Record<string, boolean>;
};

type ActionName =
  | 'thank_visitor'
  | 'ask_to_wait'
  | 'relay_message'
  | 'end_interaction';

const navigation: Array<{id: View; label: string}> = [
  {id: 'live', label: 'Live'},
  {id: 'activity', label: 'Activity'},
  {id: 'policies', label: 'Policies'},
  {id: 'devices', label: 'System'},
];

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {'content-type': 'application/json', ...init?.headers},
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

function time(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
}

function title(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function StatusDot({active}: {active: boolean}) {
  return <span className={`status-dot ${active ? 'active' : ''}`} aria-hidden="true" />;
}

function ReportCard({report}: {report: VisitorReport}) {
  return (
    <section className={`report-card urgency-${report.urgency}`} aria-labelledby="report-title">
      <div className="report-heading">
        <div>
          <p className="eyebrow">Visitor report</p>
          <h2 id="report-title">{title(report.intent)}</h2>
        </div>
        <span className="urgency-pill">{report.urgency}</span>
      </div>

      <blockquote>{report.message}</blockquote>

      <dl className="report-grid">
        <div>
          <dt>Self-reported name</dt>
          <dd>{report.visitor_claimed_name ?? 'Not provided'}</dd>
        </div>
        <div>
          <dt>Self-reported relationship</dt>
          <dd>{report.relationship_claim ?? 'Not provided'}</dd>
        </div>
        <div>
          <dt>Reported location</dt>
          <dd>{report.location_detail ?? 'Not provided'}</dd>
        </div>
        <div>
          <dt>Report understanding</dt>
          <dd>{Math.round(report.confidence * 100)}%</dd>
        </div>
      </dl>

      <p className="identity-note">
        Identity details are supplied by the visitor and have not been verified.
      </p>
    </section>
  );
}

function Timeline({items}: {items: TimelineEntry[]}) {
  const ordered = [...items].sort((a, b) =>
    b.occurred_at.localeCompare(a.occurred_at),
  );
  return (
    <ol className="timeline">
      {ordered.map((item) => (
        <li key={item.id}>
          <span className="timeline-time">{time(item.occurred_at)}</span>
          <div>
            <strong>{title(item.type)}</strong>
            <p>{item.summary}</p>
            <small>{item.layer}</small>
          </div>
        </li>
      ))}
    </ol>
  );
}

function ActionPanel({interactionCase, onRefresh}: {
  interactionCase: InteractionCase;
  onRefresh: () => Promise<void>;
}) {
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState<ActionName | null>(null);
  const [result, setResult] = useState('');

  const send = async (action: ActionName, customMessage?: string) => {
    setPending(action);
    setResult('');
    try {
      await api(`/api/cases/${interactionCase.case_id}/actions`, {
        method: 'POST',
        body: JSON.stringify({action, message: customMessage}),
      });
      if (action === 'relay_message') {
        setMessage('');
      }
      setResult('Sent to the doorstep.');
      await onRefresh();
    } catch (error) {
      setResult(error instanceof Error ? error.message : 'Action failed');
    } finally {
      setPending(null);
    }
  };

  return (
    <section className="action-card" aria-labelledby="actions-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Homeowner actions</p>
          <h2 id="actions-title">Respond now</h2>
        </div>
        <span className="case-status">{interactionCase.status}</span>
      </div>

      <div className="quick-actions">
        <button disabled={pending !== null} onClick={() => void send('thank_visitor')}>
          Thank visitor
        </button>
        <button disabled={pending !== null} onClick={() => void send('ask_to_wait')}>
          Ask them to wait
        </button>
        <button className="quiet" disabled={pending !== null} onClick={() => void send('end_interaction')}>
          End interaction
        </button>
      </div>

      <label className="message-field">
        Tell Gemini what to say
        <textarea
          maxLength={300}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Thanks for letting me know. I’m checking the leak now."
          rows={3}
          value={message}
        />
      </label>
      <button
        className="primary"
        disabled={pending !== null || !message.trim()}
        onClick={() => void send('relay_message', message.trim())}
      >
        Send response
      </button>
      {result && <p className="action-result" role="status">{result}</p>}
    </section>
  );
}

function LiveView({interactionCase, onRefresh}: {
  interactionCase?: InteractionCase;
  onRefresh: () => Promise<void>;
}) {
  if (!interactionCase) {
    return (
      <section className="empty-card">
        <p className="eyebrow">Front door</p>
        <h1>No interactions yet</h1>
        <p>Doorman is ready. New visitor activity will appear here automatically.</p>
      </section>
    );
  }

  return (
    <div className="content-grid">
      <div className="main-column">
        <section className="case-header">
          <div>
            <p className="eyebrow">Latest interaction · {time(interactionCase.updated_at)}</p>
            <h1>{interactionCase.visitor_report ? 'A visitor needs your attention' : title(interactionCase.decision.classification)}</h1>
            <p>{interactionCase.decision.decision_summary}</p>
          </div>
          <span className={`case-status status-${interactionCase.status}`}>
            {interactionCase.status}
          </span>
        </section>

        {interactionCase.visitor_report && <ReportCard report={interactionCase.visitor_report} />}

        <section className="timeline-card">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Observability</p>
              <h2>Interaction timeline</h2>
            </div>
            <button className="quiet" onClick={() => void onRefresh()}>Refresh</button>
          </div>
          <Timeline items={interactionCase.timeline} />
        </section>
      </div>

      <ActionPanel interactionCase={interactionCase} onRefresh={onRefresh} />
    </div>
  );
}

function ActivityView({cases}: {cases: InteractionCase[]}) {
  return (
    <section className="page-card">
      <p className="eyebrow">Stored cases</p>
      <h1>Activity</h1>
      <div className="case-list">
        {cases.map((item) => (
          <article key={item.case_id}>
            <div>
              <strong>{item.visitor_report ? title(item.visitor_report.intent) : title(item.decision.classification)}</strong>
              <p>{item.visitor_report?.message ?? item.decision.decision_summary}</p>
            </div>
            <div className="case-list-meta">
              <span>{item.status}</span>
              <time>{time(item.updated_at)}</time>
            </div>
          </article>
        ))}
        {!cases.length && <p>No activity has been stored.</p>}
      </div>
    </section>
  );
}

function PoliciesView({policies, onRefresh}: {policies: Policy[]; onRefresh: () => Promise<void>}) {
  const toggle = async (policy: Policy) => {
    await api(`/api/policies/${policy.id}`, {
      method: 'PUT',
      body: JSON.stringify({enabled: !policy.enabled}),
    });
    await onRefresh();
  };
  return (
    <section className="page-card">
      <p className="eyebrow">Household rules</p>
      <h1>Policies</h1>
      <div className="policy-list">
        {policies.map((policy) => (
          <article key={policy.id}>
            <div>
              <strong>{policy.name}</strong>
              <p>{policy.response_text}</p>
            </div>
            <button
              aria-pressed={policy.enabled}
              className={policy.enabled ? 'toggle enabled' : 'toggle'}
              onClick={() => void toggle(policy)}
            >
              {policy.enabled ? 'Enabled' : 'Disabled'}
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

function DevicesView({status}: {status?: ApiStatus}) {
  return (
    <section className="page-card">
      <p className="eyebrow">Runtime</p>
      <h1>System</h1>
      <div className="integration-list">
        {Object.entries(status?.integrations ?? {}).map(([name, active]) => (
          <div key={name}>
            <StatusDot active={active} />
            <span>{title(name)}</span>
            <strong>{active ? 'Connected' : 'Not reported'}</strong>
          </div>
        ))}
      </div>
      {status && (
        <dl className="system-summary">
          <div><dt>Backend</dt><dd>{status.mode}</dd></div>
          <div><dt>Agent</dt><dd>{status.agent_mode}</dd></div>
          <div><dt>Cases</dt><dd>{status.cases}</dd></div>
          <div><dt>Policies enabled</dt><dd>{status.enabled_policies}</dd></div>
        </dl>
      )}
    </section>
  );
}

export function App() {
  const [view, setView] = useState<View>('live');
  const [cases, setCases] = useState<InteractionCase[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [status, setStatus] = useState<ApiStatus>();
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState<Date>();

  const refresh = useCallback(async () => {
    try {
      const [caseData, policyData, statusData] = await Promise.all([
        api<{items: InteractionCase[]}>('/api/cases'),
        api<{items: Policy[]}>('/api/policies'),
        api<ApiStatus>('/api/status'),
      ]);
      setCases(caseData.items);
      setPolicies(policyData.items);
      setStatus(statusData);
      setUpdatedAt(new Date());
      setError('');
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Unable to refresh');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_500);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const latestCase = useMemo(() => cases[0], [cases]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <span className="brand">Doorman</span>
          <span className="brand-subtitle">Homeowner console</span>
        </div>
        <div className="connection-state" role="status">
          <StatusDot active={!error} />
          {error ? `Disconnected · ${error}` : `Live${updatedAt ? ` · ${time(updatedAt.toISOString())}` : ''}`}
        </div>
      </header>

      <nav className="navigation" aria-label="Doorman sections">
        {navigation.map((item) => (
          <button
            aria-current={view === item.id ? 'page' : undefined}
            key={item.id}
            onClick={() => setView(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <main>
        {view === 'live' && <LiveView interactionCase={latestCase} onRefresh={refresh} />}
        {view === 'activity' && <ActivityView cases={cases} />}
        {view === 'policies' && <PoliciesView policies={policies} onRefresh={refresh} />}
        {view === 'devices' && <DevicesView status={status} />}
      </main>
    </div>
  );
}
