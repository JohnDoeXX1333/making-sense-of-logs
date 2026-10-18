import type { DatasetInfo, Insights as InsightsData, LineFilter, Mover } from '../../shared/contract.ts'

const fmt = (n: number) => n.toLocaleString('en-US')

// Change text such as "up 216% vs previous 7 days"; never a percentage on a zero baseline.
function delta(now: number, before: number | null, unit = ''): { text: string; dir: 'up' | 'down' | 'same' } | null {
  if (before === null) return null
  if (before === 0) return now === 0 ? { text: 'none before either', dir: 'same' } : { text: 'none in the previous period', dir: 'up' }
  const change = Math.round(((now - before) / before) * 100)
  if (change === 0) return { text: 'no change', dir: 'same' }
  return { text: `${change > 0 ? 'up' : 'down'} ${Math.abs(change)}${unit || '%'}`, dir: change > 0 ? 'up' : 'down' }
}

// Direction colour only where up is bad (alerts); total volume stays neutral.
function Kpi({ label, value, d, help, neutral = false }: { label: string; value: string; d: ReturnType<typeof delta>; help?: string; neutral?: boolean }) {
  return (
    <div className="kpi">
      <dt>{label}</dt>
      <dd>
        <span className="kpi-value">{value}</span>
        {d && (
          <span className={`kpi-delta ${neutral ? 'same' : d.dir}`}>
            <span aria-hidden="true">{d.dir === 'up' ? '▲' : d.dir === 'down' ? '▼' : '='}</span> {d.text}
          </span>
        )}
        {help && <span className="kpi-help">{help}</span>}
      </dd>
    </div>
  )
}

function MoverList({ title, items, field, onShow, period }: { title: string; items: Mover[]; field: 'label' | 'node'; onShow: (f: LineFilter, title: string) => void; period: { from: string; to: string } }) {
  const max = Math.max(1, ...items.map((m) => m.now))
  return (
    <div className="panel panel-body">
      <h3 className="chart-title">{title}</h3>
      {items.length === 0 ? (
        <p className="muted">Nothing grew compared with the previous period.</p>
      ) : (
        <ul className="movers">
          {items.map((m) => {
            const isNew = m.firstSeen !== null && m.firstSeen >= period.from
            return (
              <li key={m.key}>
                <button type="button" className="mover" onClick={() => onShow({ field, value: m.key, alertsOnly: true, ...period }, `Alert lines where ${field} = ${m.key} in the selected period`)}>
                  <span className="mover-key">{m.key}</span>
                  <span className="mover-bars" aria-hidden="true">
                    <span className="before" style={{ width: `${(m.before / max) * 100}%` }} />
                    <span className="now" style={{ width: `${(m.now / max) * 100}%` }} />
                  </span>
                  <span className="mover-num">
                    {fmt(m.before)} → <b>{fmt(m.now)}</b>
                    {isNew ? <span className="pill">first seen</span> : m.before === 0 ? <span className="pill quiet">none before</span> : null}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export function InsightsPanel({ data, dataset, onShow, onClear, onAsk }: {
  data: InsightsData
  dataset: DatasetInfo
  onShow: (f: LineFilter, title: string) => void
  onClear: (() => void) | null
  onAsk: ((question: string) => void) | null
}) {
  const k = data.kpis
  const prev = data.previous
  const periodText = onClear ? `${data.period.from.slice(0, 16)} to ${data.period.to.slice(0, 16)}` : 'Whole dataset'
  return (
    <div className="insights" aria-live="polite">
      <div className="insights-head">
        <div>
          <span className="eyebrow">{onClear ? 'Selected period' : 'Period'}</span>
          <p className="period">{periodText}{prev ? <span className="muted"> · compared with the previous {prev.length}</span> : onClear ? <span className="muted"> · no equal earlier period in the data to compare with</span> : <span className="muted"> · drag across the chart to select a period and compare it</span>}</p>
        </div>
        <div className="insights-actions">
          {onAsk && <button type="button" className="btn-secondary" onClick={() => onAsk(`What happened between ${data.period.from.slice(0, 16)} and ${data.period.to.slice(0, 16)}, and what changed compared with before?`)}>Ask the agent about this period</button>}
          {onClear && <button type="button" className="btn-secondary" onClick={onClear}>Clear selection</button>}
        </div>
      </div>
      <dl className="kpis">
        <Kpi label="Log lines" value={fmt(k.lines)} d={delta(k.lines, k.prevLines)} neutral />
        <Kpi label="Alert lines" value={fmt(k.alerts)} d={delta(k.alerts, k.prevAlerts)} />
        <Kpi label="Alert share" value={`${k.share}%`} d={k.prevShare === null ? null : k.share === k.prevShare ? { text: 'same as before', dir: 'same' } : { text: `${k.share > k.prevShare ? 'up' : 'down'} from ${k.prevShare}%`, dir: k.share > k.prevShare ? 'up' : 'down' }} help="of all log lines" />
        {data.peak && <Kpi label={`Busiest ${data.peak.x.length === 10 ? 'day' : 'time'}`} value={data.peak.x} d={null} help={`${fmt(data.peak.alerts)} alert lines`} />}
      </dl>
      <div className="takeaways">
        <h3 className="section-title">Key takeaways <span className="muted">computed from the data, no AI</span></h3>
        <ul>
          {data.takeaways.map((t) => (
            <li key={t.text}>
              <span>{t.text}</span>
              {t.filter && (
                <button type="button" className="link-button" onClick={() => onShow(t.filter!, t.text)}>Show lines</button>
              )}
            </li>
          ))}
        </ul>
      </div>
      {data.movers && (
        <div className="changed">
          <h3 className="section-title">What changed compared with the previous {prev?.length}</h3>
          <div className="overview-lists">
            <MoverList title={`Alert ${dataset.kind === 'builtin' ? 'categories' : 'patterns'} that grew`} items={data.movers.labels} field="label" onShow={onShow} period={data.period} />
            <MoverList title="Nodes that grew" items={data.movers.nodes} field="node" onShow={onShow} period={data.period} />
          </div>
          <div className="legend"><span><i style={{ background: 'var(--text-3)' }} />previous period</span><span><i style={{ background: 'var(--series-2)' }} />selected period</span></div>
        </div>
      )}
    </div>
  )
}
