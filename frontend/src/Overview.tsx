import { useEffect, useState } from 'react'
import type { DatasetInfo, Insights as InsightsData, LineFilter, LinesResponse, Overview as OverviewData, OverviewChart } from '../../shared/contract.ts'
import { Chart } from './Chart.tsx'
import { InsightsPanel } from './Insights.tsx'

const fmt = (n: number) => n.toLocaleString('en-US')

type Selection = { filter: LineFilter; title: string }
type Range = { from: string; to: string }
const UNIT_MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000 }
// Chart bucket labels are "YYYY-MM-DD" or "YYYY-MM-DD HH:MM"; turn them into range bounds.
const bucketStart = (x: string) => (x.length === 10 ? `${x} 00:00:00` : `${x}:00`)
const bucketEnd = (x: string, unit: keyof typeof UNIT_MS) => new Date(Date.parse(`${bucketStart(x).replace(' ', 'T')}Z`) + UNIT_MS[unit]).toISOString().slice(0, 19).replace('T', ' ')
// Range ends are exclusive; show the last day that is included.
const lastIncluded = (to: string) => new Date(Date.parse(`${to.replace(' ', 'T')}Z`) - 1).toISOString().slice(0, 10)
const rangeQuery = (r: Range | null) => (r ? `from=${encodeURIComponent(r.from)}&to=${encodeURIComponent(r.to)}` : '')

function BarList({ chart, onSelect, selected }: { chart: OverviewChart; onSelect: (i: number) => void; selected: string | null }) {
  const other = chart.series[0]?.values ?? []
  const alerts = chart.series[1]?.values ?? []
  const max = Math.max(1, ...chart.x.map((_, i) => (alerts[i] ?? 0) + (other[i] ?? 0)))
  return (
    <div className="barlist">
      <h3 className="chart-title">{chart.title}</h3>
      <div className="legend" style={{ marginTop: 0, marginBottom: 8 }}><span><i style={{ background: 'var(--series-1)' }} />other lines</span><span><i style={{ background: 'var(--series-2)' }} />alert lines</span></div>
      <ul>
        {chart.x.map((x, i) => {
          const a = alerts[i] ?? 0
          const o = other[i] ?? 0
          return (
            <li key={x}>
              <button type="button" className={`barlist-row${selected === x ? ' active' : ''}`} onClick={() => onSelect(i)} title={`${x}: ${fmt(a)} alert lines, ${fmt(o)} other lines`}>
                <span className="barlist-label">{x}</span>
                <span className="barlist-track" aria-hidden="true">
                  <span style={{ width: `${(o / max) * 100}%`, background: 'var(--series-1)' }} />
                  <span style={{ width: `${(a / max) * 100}%`, background: 'var(--series-2)' }} />
                </span>
                <span className="barlist-num">{fmt(a + o)}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export function Overview({ dataset, onAsk }: { dataset: DatasetInfo; onAsk: (question: string) => void }) {
  const [data, setData] = useState<OverviewData | null>(null)
  const [range, setRange] = useState<Range | null>(null)
  const [insights, setInsights] = useState<InsightsData | null>(null)
  const [fromInput, setFromInput] = useState('')
  const [toInput, setToInput] = useState('')
  const [rangeError, setRangeError] = useState('')
  const [error, setError] = useState('')
  const [sel, setSel] = useState<Selection | null>(null)
  const [lines, setLines] = useState<LinesResponse | null>(null)
  const [linesError, setLinesError] = useState('')
  const [showSql, setShowSql] = useState(false)

  useEffect(() => {
    setSel(null)
    setLines(null)
    setError('')
    const q = rangeQuery(range)
    const get = (path: string) => fetch(`/api/datasets/${dataset.id}/${path}${q ? `?${q}` : ''}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    get('overview').then(setData).catch((e: Error) => setError(e.message))
    get('insights').then(setInsights).catch((e: Error) => setError(e.message))
  }, [dataset.id, range])

  useEffect(() => {
    if (!sel) return
    setLines(null)
    setLinesError('')
    const f = sel.filter
    const q = new URLSearchParams({ field: f.field, value: f.value, ...(f.unit ? { unit: f.unit } : {}), ...(f.alertsOnly ? { alerts: '1' } : {}), ...(f.from && f.to ? { from: f.from, to: f.to } : {}) })
    fetch(`/api/datasets/${dataset.id}/lines?${q}`)
      .then((r) => (r.ok ? r.json() : r.json().then((b) => Promise.reject(new Error(b.error ?? `HTTP ${r.status}`)))))
      .then(setLines)
      .catch((e: Error) => setLinesError(e.message))
  }, [sel, dataset.id])

  const time = data?.charts.find((c) => c.field === 'time')
  const lists = data?.charts.filter((c) => c.field !== 'time') ?? []
  const hasNodes = data?.patterns.some((p) => p.nodes > 0) ?? false
  const pick = (c: OverviewChart, i: number) => {
    const value = c.x[i]!
    const scope = c.field !== 'time' && range ? { from: range.from, to: range.to } : {}
    setSel({ filter: { field: c.field, value, unit: c.unit, ...scope }, title: c.field === 'time' ? `Lines in the ${c.unit} starting ${value}` : `Lines where ${c.field} = ${value}${range ? ' in the selected period' : ''}` })
  }
  const unit = (time?.unit ?? 'day') as keyof typeof UNIT_MS
  const brush = (i0: number, i1: number) => {
    if (!time) return
    setRange({ from: bucketStart(time.x[i0]!), to: bucketEnd(time.x[i1]!, unit) })
  }
  const brushed: [number, number] | null = range && time
    ? (() => {
        const i0 = time.x.findIndex((x) => bucketStart(x) >= range.from)
        const i1 = time.x.findLastIndex((x) => bucketStart(x) < range.to)
        return i0 >= 0 && i1 >= i0 ? [i0, i1] : null
      })()
    : null
  const applyTyped = () => {
    const norm = (v: string) => (v ? `${v.replace('T', ' ')}${v.length === 16 ? ':00' : ''}` : '')
    const from = norm(fromInput)
    const to = norm(toInput)
    if (!from || !to || from >= to) {
      setRangeError('Enter a start and an end, with the start first.')
      return
    }
    setRangeError('')
    setRange({ from, to })
  }
  const show = (filter: LineFilter, title: string) => {
    setSel({ filter, title })
    requestAnimationFrame(() => document.getElementById('drill')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }))
  }

  return (
    <section className="overview container" id="overview" aria-labelledby="overview-title">
      <div className="overview-head">
        <div>
          <span className="eyebrow">Overview, computed by SereneDB without AI</span>
          <h2 id="overview-title">{dataset.name}</h2>
        </div>
        {data && (
          <dl className="stats">
            <div><dt>Lines</dt><dd>{fmt(data.rows)}</dd></div>
            <div><dt>Alert lines</dt><dd>{fmt(data.alerts)}</dd></div>
            <div><dt>{range ? 'Selected from' : 'From'}</dt><dd>{(range?.from ?? dataset.timeFrom)?.slice(0, 10) ?? 'n/a'}</dd></div>
            <div><dt>{range ? 'Selected to' : 'To'}</dt><dd>{range ? lastIncluded(range.to) : (dataset.timeTo ? lastIncluded(dataset.timeTo) : 'n/a')}</dd></div>
          </dl>
        )}
      </div>
      <details className="notes">
        <summary>How the fields were derived</summary>
        <ul>{dataset.notes.map((n) => <li key={n}>{n}</li>)}</ul>
      </details>
      {error && <div className="error-box" role="alert">The overview could not be loaded: {error}</div>}
      {!data && !error && <p className="muted">Loading the overview</p>}
      {data && (
        <div className="overview-grid">
          {time && (
            <div className="panel panel-body overview-time">
              <Chart
                chart={time} width={1200}
                onSelect={(i) => pick(time, i)} onBrush={brush} brushed={brushed}
                selected={sel?.filter.field === 'time' ? time.x.indexOf(sel.filter.value) : null}
                peak={insights?.peak ? time.x.indexOf(insights.peak.x) : null}
                spikes={(insights?.spikes ?? []).map((x) => time.x.indexOf(x)).filter((i) => i >= 0)}
              />
              <div className="range-form">
                <span className="muted">Drag across the chart to select a period, or type one:</span>
                <label htmlFor="range-from">From</label>
                <input id="range-from" type="datetime-local" value={fromInput} onChange={(e) => setFromInput(e.target.value)} aria-describedby={rangeError ? 'range-error' : undefined} />
                <label htmlFor="range-to">To</label>
                <input id="range-to" type="datetime-local" value={toInput} onChange={(e) => setToInput(e.target.value)} aria-describedby={rangeError ? 'range-error' : undefined} />
                <button type="button" className="btn-secondary" onClick={applyTyped}>Select period</button>
                {rangeError && <span className="field-error" id="range-error">{rangeError}</span>}
              </div>
            </div>
          )}
          {insights && (
            <InsightsPanel
              data={insights} dataset={dataset} onShow={show}
              onClear={range ? () => setRange(null) : null}
              onAsk={range ? onAsk : null}
            />
          )}
          <div className="overview-lists">
            {lists.map((c) => (
              <div className="panel panel-body" key={c.id}>
                <BarList chart={c} onSelect={(i) => pick(c, i)} selected={sel?.filter.field === c.field ? sel.filter.value : null} />
              </div>
            ))}
          </div>
          {data.patterns.length > 0 && (
            <div className="panel overview-patterns">
              <div className="panel-head"><h3>{dataset.kind === 'builtin' ? 'Most frequent alert categories' : 'Most frequent alert patterns'}</h3>{dataset.kind !== 'builtin' && <span className="meta">numbers and ids replaced by &lt;*&gt;</span>}</div>
              <div className="table-wrap" style={{ border: 0, borderRadius: 0 }}>
                <table>
                  <thead><tr><th scope="col">{dataset.kind === 'builtin' ? 'Category' : 'Pattern'}</th><th scope="col" className="num">Lines</th>{hasNodes && <th scope="col" className="num">Nodes</th>}<th scope="col">First</th><th scope="col">Last</th></tr></thead>
                  <tbody>
                    {data.patterns.map((p) => (
                      <tr key={p.label}>
                        <td><button type="button" className="link-button pattern-link" onClick={() => show({ field: 'label', value: p.label, ...(range ?? {}) }, `Lines with ${dataset.kind === 'builtin' ? 'category' : 'pattern'} ${p.label}${range ? ' in the selected period' : ''}`)}>{p.label}</button></td>
                        <td className="num">{fmt(p.events)}</td>
                        {hasNodes && <td className="num">{fmt(p.nodes)}</td>}
                        <td>{p.first?.slice(0, 19) ?? ''}</td>
                        <td>{p.last?.slice(0, 19) ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
      {sel && (
        <div className="panel drill" id="drill" aria-live="polite">
          <div className="panel-head">
            <h3>{sel.title}</h3>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              {lines && <span className="meta">{fmt(lines.total)} {lines.total === 1 ? 'line' : 'lines'}{lines.total > lines.rows.length ? `, first ${lines.rows.length} shown` : ''}</span>}
              <button type="button" className="link-button" onClick={() => setShowSql((v) => !v)} aria-expanded={showSql}>SQL</button>
              <button type="button" className="close" onClick={() => setSel(null)} aria-label="Close lines">
                <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.6" /></svg>
              </button>
            </div>
          </div>
          {showSql && lines && <pre className="sql" style={{ margin: 16 }}>{lines.sql}</pre>}
          {linesError && <div className="error-box" role="alert" style={{ margin: 16 }}>{linesError}</div>}
          {!lines && !linesError && <p className="muted" style={{ padding: 16 }}>Loading lines</p>}
          {lines && (
            <div className="table-wrap drill-table" style={{ border: 0, borderRadius: 0 }}>
              <table className="log-table">
                <thead><tr><th scope="col">Line</th><th scope="col">Time</th><th scope="col">Node</th><th scope="col">Level</th><th scope="col">Message</th></tr></thead>
                <tbody>
                  {lines.rows.map((r) => (
                    <tr key={r.lineId}>
                      <td className="mono">{r.lineId}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{r.time}</td>
                      <td className="mono">{r.node}</td>
                      <td>{r.isAlert ? <span className="alert-tag">{r.level}</span> : r.level}</td>
                      <td className="msg">{r.message || <em>(empty message)</em>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
