import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { DatasetInfo, EvidenceBundle, Fact, Finding, Health, InvestigateEvent, InvestigateResponse, LogRow, Role, RoleView, ToolCall } from '../../shared/contract.ts'
import { Chart } from './Chart.tsx'
import { Overview } from './Overview.tsx'
import { UploadDialog } from './UploadDialog.tsx'

const ROLES: { id: Role; name: string; hint: string }[] = [
  { id: 'engineer', name: 'Engineer', hint: 'root cause' },
  { id: 'team_lead', name: 'Team lead', hint: 'recurring problems' },
  { id: 'manager', name: 'Manager', hint: 'risks and priorities' },
]
const fmt = (v: number | string | undefined) => (typeof v === 'number' ? v.toLocaleString('en-US') : (v ?? ''))
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`

function argsSummary(args: Record<string, unknown>) {
  return Object.entries(args)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(' · ')
}

function StatusBadge({ status }: { status: Finding['status'] }) {
  return status === 'observed' ? (
    <span className="status observed">
      <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M4.8 8.2l2.1 2.1 4.3-4.6" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
      Observed
    </span>
  ) : (
    <span className="status inferred">
      <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.5 2" /><path d="M8 4.5v4.2M8 10.8v.7" stroke="currentColor" strokeWidth="1.6" /></svg>
      Inferred
    </span>
  )
}

function RolePanel({ view, onFact }: { view: RoleView | { role: Role; error: string }; onFact: (id: string) => void }) {
  if ('error' in view) {
    return (
      <div className="view">
        <div className="error-box" role="alert">{view.error}. The evidence on the right is still valid.</div>
      </div>
    )
  }
  return (
    <div className="view">
      <div>
        <h2>{view.headline}</h2>
        <p className="summary">{view.summary}</p>
      </div>
      <div>
        <h3 className="section-title">Findings</h3>
        <ul className="findings">
          {view.findings.map((f, i) => (
            <li className="finding" key={i}>
              <StatusBadge status={f.status} />
              <div>
                <p>{f.claim}</p>
                <div className="finding-meta">
                  <span>Confidence {f.confidence}</span>
                  <span aria-hidden="true">·</span>
                  <span>Evidence</span>
                  {f.evidenceIds.map((id) => (
                    <button type="button" className="fact-chip" key={id} onClick={() => onFact(id)} aria-label={`Open evidence ${id}`}>{id}</button>
                  ))}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
      {view.priorities && view.priorities.length > 0 && (
        <div>
          <h3 className="section-title">Priority, computed from the logs</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Alert category</th>
                  <th scope="col">Score</th>
                  <th scope="col" className="num">Events</th>
                  <th scope="col" className="num">Nodes</th>
                  <th scope="col" className="num">Active days</th>
                  <th scope="col" className="num">Trend</th>
                  <th scope="col" className="num">Fatal share</th>
                  <th scope="col"><span className="visually-hidden">Evidence</span></th>
                </tr>
              </thead>
              <tbody>
                {view.priorities.map((p) => (
                  <tr key={p.label}>
                    <td><span className="label-name">{p.label}</span></td>
                    <td>
                      <div className="scorebar"><b>{p.score}</b><span className="track"><span className="fill" style={{ display: 'block', width: `${p.score}%` }} /></span></div>
                    </td>
                    <td className="num">{fmt(p.inputs.events)}</td>
                    <td className="num">{fmt(p.inputs.nodes)}</td>
                    <td className="num">{p.inputs.activeDays}</td>
                    <td className="num">{p.inputs.trendPct === null ? 'n/a' : `${p.inputs.trendPct > 0 ? '+' : ''}${p.inputs.trendPct}%`}</td>
                    <td className="num">{Math.round(p.inputs.fatalShare * 100)}%</td>
                    <td>{p.factIds.map((id) => <button type="button" className="fact-chip" key={id} onClick={() => onFact(id)} aria-label={`Open evidence ${id}`}>{id}</button>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="formula">Score = 100 × (0.30 events + 0.25 nodes + 0.20 active days + 0.15 fatal share + 0.10 trend), each scaled against the largest category. Trend compares the last quarter of the period with the quarter before.</p>
        </div>
      )}
      <div className="two-col">
        <div>
          <h3 className="section-title">Recommended next steps</h3>
          <ul className="bullets">{view.recommendedActions.map((a, i) => <li key={i}>{a}</li>)}</ul>
        </div>
        <div className="unknowns">
          <h3 className="section-title">What the logs cannot tell us</h3>
          <ul>{view.unknowns.map((u, i) => <li key={i}>{u}</li>)}</ul>
        </div>
      </div>
    </div>
  )
}

type DrawerContent = { kind: 'fact'; fact: Fact } | { kind: 'call'; call: ToolCall }

function Drawer({ content, bundle, onClose }: { content: DrawerContent | null; bundle: EvidenceBundle | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [openRaw, setOpenRaw] = useState<number | null>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (content && !d.open) d.showModal()
    if (!content && d.open) d.close()
  }, [content])
  if (!bundle) return <dialog ref={ref} className="drawer" onClose={onClose} />
  const call = content?.kind === 'call' ? content.call : content ? bundle.toolCalls.find((t) => t.id === content.fact.toolCallId) : undefined
  const rows: LogRow[] = content?.kind === 'fact' ? bundle.logs.filter((l) => content.fact.sourceLineIds.includes(l.lineId)) : []
  return (
    <dialog ref={ref} className="drawer" onClose={onClose} aria-labelledby="drawer-title">
      {content && (
        <>
          <div className="drawer-head">
            <div>
              <div className="eyebrow">{content.kind === 'fact' ? `Evidence ${content.fact.id}` : `Query ${content.call.id}`}</div>
              <h2 id="drawer-title">{content.kind === 'fact' ? content.fact.statement : content.call.tool}</h2>
            </div>
            <button type="button" className="close" onClick={onClose} aria-label="Close evidence">
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.6" /></svg>
            </button>
          </div>
          <div className="drawer-body">
            {content.kind === 'fact' && (
              <dl className="kv">
                <dt>Value</dt><dd><b>{fmt(content.fact.value)}</b></dd>
                <dt>Source rows</dt><dd>{content.fact.sourceLineIds.length ? `${content.fact.sourceLineIds.length} sample lines below` : 'Aggregate only (no single row)'}</dd>
              </dl>
            )}
            {rows.length > 0 && (
              <div>
                <h3 className="section-title">Log lines from SereneDB</h3>
                <div className="table-wrap">
                  <table className="log-table">
                    <thead><tr><th scope="col">Line</th><th scope="col">Log time</th><th scope="col">Node</th><th scope="col">Label</th><th scope="col">Message</th></tr></thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.lineId}>
                          <td className="mono">{r.lineId}</td>
                          <td style={{ whiteSpace: 'nowrap' }}>{r.time}</td>
                          <td className="mono">{r.node}</td>
                          <td className="mono">{r.label} {r.level}</td>
                          <td className="msg">
                            {r.message || <em>(empty message)</em>}
                            <div>
                              <button type="button" className="link-button" aria-expanded={openRaw === r.lineId} onClick={() => setOpenRaw(openRaw === r.lineId ? null : r.lineId)}>raw line</button>
                              {openRaw === r.lineId && <div className="raw">{r.rawLine}</div>}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {call && (
              <div>
                <h3 className="section-title">Query {call.id}: {call.tool}</h3>
                <dl className="kv" style={{ marginBottom: 12 }}>
                  <dt>Arguments</dt><dd>{argsSummary(call.args) || 'none'}</dd>
                  <dt>Result</dt><dd>{fmt(call.rowCount)} rows in {call.ms} ms</dd>
                </dl>
                <pre className="sql">{call.sql}</pre>
              </div>
            )}
          </div>
        </>
      )}
    </dialog>
  )
}

const STEPS = ['Planning read-only queries', 'Running them on SereneDB', 'Writing the three role views']

export default function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [healthError, setHealthError] = useState(false)
  const [datasets, setDatasets] = useState<DatasetInfo[]>([])
  const [datasetId, setDatasetId] = useState('bgl')
  const [uploadOpen, setUploadOpen] = useState(false)
  const [question, setQuestion] = useState('')
  const [fieldError, setFieldError] = useState('')
  const [bundle, setBundle] = useState<EvidenceBundle | null>(null)
  const [views, setViews] = useState<Partial<InvestigateResponse['views']>>({})
  const [liveCalls, setLiveCalls] = useState<ToolCall[]>([])
  const [final, setFinal] = useState<InvestigateResponse | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [role, setRole] = useState<Role>('engineer')
  const [chartIdx, setChartIdx] = useState(0)
  const [drawer, setDrawer] = useState<DrawerContent | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])

  useEffect(() => {
    fetch('/api/health').then((r) => (r.ok ? r.json() : Promise.reject())).then(setHealth).catch(() => setHealthError(true))
    fetch('/api/datasets').then((r) => r.json()).then(setDatasets).catch(() => setDatasets([]))
  }, [])

  useEffect(() => {
    if (!loading) return
    const started = Date.now()
    const t = setInterval(() => setElapsed(Date.now() - started), 200)
    return () => clearInterval(t)
  }, [loading])

  async function run(q: string) {
    const text = q.trim()
    if (text.length < 3) {
      setFieldError('Write a question of at least 3 characters.')
      return
    }
    setFieldError('')
    setQuestion(text)
    setLoading(true)
    setElapsed(0)
    setError('')
    setBundle(null)
    setViews({})
    setLiveCalls([])
    setFinal(null)
    setDrawer(null)
    setChartIdx(0)
    document.getElementById('results')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    const handle = (e: InvestigateEvent) => {
      if (e.type === 'tool') setLiveCalls((c) => [...c, e.call])
      else if (e.type === 'bundle') setBundle(e.bundle)
      else if (e.type === 'view') setViews((v) => ({ ...v, [e.role]: e.view }))
      else if (e.type === 'done') {
        setFinal(e.response)
        setBundle(e.response.bundle)
        setViews(e.response.views)
      } else throw new Error(e.error)
    }
    try {
      // The selected role is written first, so the tab the user is looking at fills in first.
      const res = await fetch(`/api/investigate/stream?first=${role}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: text, dataset: datasetId }) })
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
      let buf = ''
      let finished = false
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += value
        let nl = buf.indexOf('\n')
        while (nl >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          if (line.trim()) {
            const event = JSON.parse(line) as InvestigateEvent
            if (event.type === 'done') finished = true
            handle(event)
          }
          nl = buf.indexOf('\n')
        }
      }
      if (!finished) throw new Error('the connection closed before the answer was complete')
    } catch (err) {
      setError(`The investigation failed: ${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    void run(question)
  }

  function openFact(id: string) {
    const fact = bundle?.facts.find((f) => f.id === id)
    if (fact) setDrawer({ kind: 'fact', fact })
  }

  function onTabKey(e: KeyboardEvent, i: number) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    const next = (i + (e.key === 'ArrowRight' ? 1 : ROLES.length - 1)) % ROLES.length
    setRole(ROLES[next]!.id)
    tabRefs.current[next]?.focus()
  }

  const b = bundle
  const dataset = datasets.find((d) => d.id === datasetId)
  const examples = dataset?.examples ?? []

  function switchDataset(id: string) {
    setDatasetId(id)
    setBundle(null)
    setViews({})
    setLiveCalls([])
    setFinal(null)
    setError('')
    setQuestion('')
  }

  function onLoaded(ds: DatasetInfo) {
    setDatasets((list) => [...list.filter((d) => d.id !== ds.id), ds])
    setUploadOpen(false)
    switchDataset(ds.id)
    requestAnimationFrame(() => document.getElementById('overview')?.scrollIntoView({ behavior: 'smooth' }))
  }
  const roleName = ROLES.find((r) => r.id === role)!.name

  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      <header className={`site-header${menuOpen ? ' open' : ''}`}>
        <div className="container">
          <a className="brand" href="#top">
            <svg className="brand-mark" viewBox="0 0 18 18" aria-hidden="true"><rect x="1" y="3" width="16" height="2" rx="1" fill="var(--text-3)" /><rect x="1" y="8" width="11" height="2" rx="1" fill="var(--accent-hover)" /><rect x="1" y="13" width="14" height="2" rx="1" fill="var(--text-3)" /></svg>
            Making Sense of Logs
          </a>
          <button type="button" className="menu-button" aria-expanded={menuOpen} aria-controls="site-nav" aria-label="Menu" onClick={() => setMenuOpen((v) => !v)}>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" /></svg>
          </button>
          <nav className="nav" id="site-nav" aria-label="Sections">
            <a href="#top" onClick={() => setMenuOpen(false)}>Investigate</a>
            <a href="#overview" onClick={() => setMenuOpen(false)}>Overview</a>
            <a href="#evidence" onClick={() => setMenuOpen(false)}>Evidence</a>
            <a href="#trace" onClick={() => setMenuOpen(false)}>How it was built</a>
          </nav>
          <div className="health" aria-live="polite">
            <span className={`dot${healthError ? ' down' : ''}`} aria-hidden="true" />
            {healthError ? 'Backend unreachable' : health ? (
              <>
                <span>{health.serenedbVersion}</span><span className="sep">·</span>
                <span>{fmt(health.rows)} log lines</span><span className="sep">·</span>
                <span>{health.searchMode === 'bm25' ? 'BM25 ranking' : 'Relevance scoring unavailable, exact matching in use'}</span>
              </>
            ) : 'Connecting'}
          </div>
        </div>
      </header>

      <main id="main">
        <section className="ask container" id="top" aria-labelledby="page-title">
          <div className="ask-grid">
            <div className="ask-intro">
              <h1 id="page-title">One investigation, three perspectives</h1>
              <p>Ask about 4.7 million Blue Gene/L log lines, or upload your own logs. SereneDB finds the evidence and computes the numbers; the agent explains the same evidence for an engineer, a team lead and a manager.</p>
            </div>
            <form className="ask-form" onSubmit={onSubmit} noValidate>
              <div className="dataset-row">
                <label htmlFor="dataset">Logs</label>
                <select id="dataset" value={datasetId} onChange={(e) => switchDataset(e.target.value)} disabled={loading}>
                  {datasets.map((d) => <option key={d.id} value={d.id}>{d.name} ({d.rows.toLocaleString('en-US')} lines)</option>)}
                </select>
                <button type="button" className="btn-secondary" onClick={() => setUploadOpen(true)} disabled={loading}>Upload your own logs</button>
              </div>
              <label htmlFor="question">Your question</label>
              <div className="ask-row">
                <textarea
                  id="question" name="question" rows={2} value={question} autoComplete="off"
                  aria-invalid={fieldError ? true : undefined} aria-describedby={fieldError ? 'question-error' : undefined}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void run(question) } }}
                  placeholder="What happened around the runtime panics on 2005-07-11?"
                />
                <button type="submit" className="btn-primary" disabled={loading}>{loading ? 'Investigating' : 'Investigate'}</button>
              </div>
              {fieldError && <p className="field-error" id="question-error">{fieldError}</p>}
              <div className="examples" aria-label="Example questions">
                {examples.map((ex) => (
                  <button type="button" className="chip" key={ex.id} disabled={loading} onClick={() => void run(ex.question)}>
                    <span className="role-tag">{ROLES.find((r) => r.id === ex.role)?.name}</span>
                    {ex.question}
                  </button>
                ))}
              </div>
            </form>
          </div>
        </section>

        {dataset && <Overview dataset={dataset} key={dataset.id} onAsk={(q) => void run(q)} />}

        <section className="results container" id="results" aria-label="Results">
          <div className="panel" aria-busy={loading}>
            <div className="tabs" role="tablist" aria-label="Perspective">
              {ROLES.map((r, i) => (
                <button
                  key={r.id} ref={(el) => { tabRefs.current[i] = el }} type="button" role="tab" id={`tab-${r.id}`} className="tab"
                  aria-selected={role === r.id} aria-controls="role-panel" tabIndex={role === r.id ? 0 : -1}
                  onClick={() => setRole(r.id)} onKeyDown={(e) => onTabKey(e, i)}
                >
                  {r.name} <span className="hint">{r.hint}</span>
                  {loading && !views[r.id] && <><span className="spinner" aria-hidden="true" /><span className="visually-hidden">(being written)</span></>}
                </button>
              ))}
            </div>
            <div id="role-panel" role="tabpanel" aria-labelledby={`tab-${role}`}>
              {views[role] ? (
                <>
                  {error && <div className="view" style={{ paddingBottom: 0 }}><div className="error-box" role="alert">{error}</div></div>}
                  <RolePanel view={views[role]!} onFact={openFact} />
                </>
              ) : error ? (
                <div className="view"><div className="error-box" role="alert">{error}</div></div>
              ) : loading && !b ? (
                <div className="placeholder" aria-live="polite">
                  <h2 style={{ display: 'flex', alignItems: 'center', gap: 12 }}><span className="spinner" aria-hidden="true" />Collecting evidence, {secs(elapsed)}</h2>
                  <p>The agent picks read-only queries; SereneDB runs them. New questions take about 30 seconds in total.</p>
                  <ol className="steps">
                    {liveCalls.length === 0 && <li className="now">{STEPS[0]}</li>}
                    {liveCalls.map((t) => (
                      <li key={t.id} className="done"><span aria-hidden="true">✓</span><span className="mono">{t.tool}</span> {fmt(t.rowCount)} rows in {t.ms} ms</li>
                    ))}
                  </ol>
                </div>
              ) : loading ? (
                <div className="placeholder" aria-live="polite">
                  <h2 style={{ display: 'flex', alignItems: 'center', gap: 12 }}><span className="spinner" aria-hidden="true" />Writing the {roleName} view, {secs(elapsed)}</h2>
                  <p>The evidence is ready on the right. The three views are written one after another from that same evidence.</p>
                </div>
              ) : (
                <div className="placeholder">
                  <h2>Pick an example or ask your own question</h2>
                  <p>Each answer comes in three versions. Switch roles to see how the explanation changes while the evidence stays the same.</p>
                </div>
              )}
            </div>
          </div>

          <aside className="evidence" id="evidence" aria-label="Evidence">
            <div className="panel">
              <div className="panel-head">
                <h2>Evidence, same for every role</h2>
                {b && <span className="meta">{b.facts.length} facts · {b.toolCalls.length} queries</span>}
              </div>
              {b && b.charts.length > 0 && (
                <div className="panel-body" style={{ borderBottom: '1px solid var(--border)' }}>
                  {b.charts.length > 1 && (
                    <div className="chart-switch" style={{ marginBottom: 12 }} aria-label="Charts">
                      {b.charts.map((c, i) => <button type="button" key={c.id} aria-pressed={chartIdx === i} onClick={() => setChartIdx(i)}>Chart {i + 1}</button>)}
                    </div>
                  )}
                  <Chart chart={b.charts[Math.min(chartIdx, b.charts.length - 1)]!} key={`${b.queryId}-${chartIdx}`} />
                </div>
              )}
              {b ? (
                <ul className="facts">
                  {b.facts.map((f) => (
                    <li key={f.id}>
                      <button type="button" className={`fact-row${drawer?.kind === 'fact' && drawer.fact.id === f.id ? ' active' : ''}`} onClick={() => setDrawer({ kind: 'fact', fact: f })}>
                        <span className="fid">{f.id}</span>
                        <span className="stmt">{f.statement}</span>
                        <span className="val">{fmt(f.value)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="panel-body" style={{ color: 'var(--text-3)', fontSize: 13 }}>Facts computed by SereneDB appear here. Every finding links to them.</p>
              )}
            </div>
          </aside>
        </section>

        {(b || liveCalls.length > 0) && (
          <section className="trace container" id="trace" aria-labelledby="trace-title">
            <div className="trace-head">
              <h2 id="trace-title">How this answer was built</h2>
              <p>{final ? `${secs(final.timings.totalMs)} total · database ${final.timings.dbMs} ms · language model ${secs(final.timings.llmMs)}${final.cachedAt ? ` · cached answer from ${new Date(final.cachedAt).toLocaleString()}` : ''}` : `In progress, ${secs(elapsed)}`}</p>
            </div>
            <div className="pipeline">
              <div className="stage">
                <span className="eyebrow">Question</span>
                <p>{b?.question ?? question}</p>
              </div>
              <div className="arrow" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M2 8h11M9 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg></div>
              <div className="stage">
                <span className="eyebrow">Read-only queries on SereneDB, chosen by the agent</span>
                <div className="calls">
                  {(b?.toolCalls ?? liveCalls).map((t) => (
                    <button type="button" className="call" key={t.id} onClick={() => setDrawer({ kind: 'call', call: t })} disabled={!b}>
                      <span className="tid">{t.id}</span>
                      <span className="tool">{t.tool}</span>
                      <span className="args">{argsSummary(t.args)}</span>
                      <span className="ms">{fmt(t.rowCount)} rows · {t.ms} ms</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="arrow" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M2 8h11M9 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg></div>
              <div className="stage">
                <span className="eyebrow">Evidence bundle</span>
                {b ? (
                  <>
                    <span className="big">{b.facts.length}</span>
                    <p>facts with {b.logs.length} source log lines. The model cannot add facts.</p>
                  </>
                ) : <p>Collecting</p>}
              </div>
              <div className="arrow" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M2 8h11M9 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg></div>
              <div className="stage">
                <span className="eyebrow">Three views</span>
                <ul className="role-list">
                  {ROLES.map((r) => {
                    const v = views[r.id]
                    return <li key={r.id}>{r.name}: {!v ? (loading ? 'being written' : 'not available') : 'error' in v ? 'unavailable' : `${v.findings.length} findings, ${v.findings.filter((f) => f.status === 'observed').length} observed`}</li>
                  })}
                </ul>
              </div>
            </div>
          </section>
        )}
      </main>

      <footer className="site-footer">
        <div className="container">
          <span>Data: Loghub BGL, 4,747,963 lines</span>
          <span>Database: SereneDB 26.10.1</span>
          <span>Model: DeepSeek V4.1 Flash</span>
          <span>Times are shown as written in the logs (BGL: US Pacific)</span>
        </div>
      </footer>

      <Drawer content={drawer} bundle={bundle} onClose={() => setDrawer(null)} />
      <UploadDialog open={uploadOpen} onClose={() => setUploadOpen(false)} onLoaded={onLoaded} />
    </>
  )
}
