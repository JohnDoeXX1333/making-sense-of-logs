import { useEffect, useState } from 'react'
import type { DatasetInfo, LinesResponse, Overview as OverviewData, OverviewChart } from '../../shared/contract.ts'
import { Chart } from './Chart.tsx'

const fmt = (n: number) => n.toLocaleString('en-US')

type Selection = { field: OverviewChart['field']; value: string; unit?: string; title: string }

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

export function Overview({ dataset }: { dataset: DatasetInfo }) {
  const [data, setData] = useState<OverviewData | null>(null)
  const [error, setError] = useState('')
  const [sel, setSel] = useState<Selection | null>(null)
  const [lines, setLines] = useState<LinesResponse | null>(null)
  const [linesError, setLinesError] = useState('')
  const [showSql, setShowSql] = useState(false)

  useEffect(() => {
    setData(null)
    setSel(null)
    setLines(null)
    setError('')
    fetch(`/api/datasets/${dataset.id}/overview`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e: Error) => setError(e.message))
  }, [dataset.id])

  useEffect(() => {
    if (!sel) return
    setLines(null)
    setLinesError('')
    const q = new URLSearchParams({ field: sel.field, value: sel.value, ...(sel.unit ? { unit: sel.unit } : {}) })
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
    setSel({ field: c.field, value, unit: c.unit, title: c.field === 'time' ? `Lines in the ${c.unit} starting ${value}` : `Lines where ${c.field} = ${value}` })
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
            <div><dt>From</dt><dd>{dataset.timeFrom?.slice(0, 10) ?? 'n/a'}</dd></div>
            <div><dt>To</dt><dd>{dataset.timeTo?.slice(0, 10) ?? 'n/a'}</dd></div>
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
              <Chart chart={time} width={1200} onSelect={(i) => pick(time, i)} selected={sel?.field === 'time' ? time.x.indexOf(sel.value) : null} />
            </div>
          )}
          <div className="overview-lists">
            {lists.map((c) => (
              <div className="panel panel-body" key={c.id}>
                <BarList chart={c} onSelect={(i) => pick(c, i)} selected={sel?.field === c.field ? sel.value : null} />
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
                        <td><button type="button" className="link-button pattern-link" onClick={() => setSel({ field: 'label', value: p.label, title: `Lines with pattern ${p.label}` })}>{p.label}</button></td>
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
        <div className="panel drill" aria-live="polite">
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
