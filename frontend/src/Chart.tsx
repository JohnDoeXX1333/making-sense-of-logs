import { useState } from 'react'
import type { Chart as ChartData } from '../../shared/contract.ts'

const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)']
const H = 220
const PAD = { top: 12, right: 8, bottom: 28, left: 44 }
const fmt = (n: number) => n.toLocaleString('en-US')

function niceMax(v: number) {
  if (v <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v) ?? v
}

// onSelect makes bars clickable (drill-down); the table view offers the same action as buttons for keyboard users.
export function Chart({ chart, onSelect, selected, width = 600 }: { chart: ChartData; onSelect?: (index: number) => void; selected?: number | null; width?: number }) {
  const W = width
  const [hover, setHover] = useState<number | null>(null)
  const [asTable, setAsTable] = useState(false)
  const n = chart.x.length
  const series = chart.series.slice(0, SERIES.length)
  const totals = chart.x.map((_, i) => series.reduce((s, sr) => s + (sr.values[i] ?? 0), 0))
  const isLine = chart.kind === 'line'
  const max = niceMax(Math.max(...(isLine ? series.flatMap((s) => s.values) : totals)))
  const iw = W - PAD.left - PAD.right
  const ih = H - PAD.top - PAD.bottom
  const y = (v: number) => PAD.top + ih - (v / max) * ih
  const step = iw / n
  const barW = Math.max(2, Math.min(40, step - 2))
  const cx = (i: number) => PAD.left + step * i + step / 2
  const ticks = [0, max / 2, max]
  const labelChars = Math.max(...chart.x.map((x) => x.length))
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(iw / (labelChars * 6.5 + 16)))))

  const tooltip = hover === null ? null : (
    <div className="tooltip" style={{ left: `${(cx(hover) / W) * 100}%`, top: `${(y(isLine ? Math.max(...series.map((s) => s.values[hover] ?? 0)) : totals[hover]!) / H) * 100}%` }}>
      <div style={{ marginBottom: 4 }}>{chart.x[hover]}{onSelect ? ' · click for lines' : ''}</div>
      {series.map((s) => (
        <div className="row" key={s.name}>
          <span>{s.name}</span>
          <b>{fmt(s.values[hover] ?? 0)}</b>
        </div>
      ))}
    </div>
  )

  return (
    <figure className="chart" style={{ margin: 0 }}>
      <figcaption className="chart-title">{chart.title}</figcaption>
      {asTable ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">{isLine ? 'Time' : 'Bucket'}</th>
                {series.map((s) => <th scope="col" className="num" key={s.name}>{s.name}</th>)}
              </tr>
            </thead>
            <tbody>
              {chart.x.map((x, i) => (
                <tr key={x}>
                  <td>{onSelect ? <button type="button" className="link-button" onClick={() => onSelect(i)}>{x}</button> : x}</td>
                  {series.map((s) => <td className="num" key={s.name}>{fmt(s.values[i] ?? 0)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ position: 'relative' }} onMouseLeave={() => setHover(null)}>
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${chart.title}. Use the table view for exact values.`}>
            <g className="grid">
              {ticks.map((t) => <line key={t} x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />)}
            </g>
            <g className="axis">
              {ticks.map((t) => <text key={t} x={PAD.left - 6} y={y(t) + 4} textAnchor="end">{fmt(Math.round(t))}</text>)}
              {chart.x.map((x, i) => (i % labelEvery === 0 ? <text key={x} x={cx(i)} y={H - 8} textAnchor="middle">{x}</text> : null))}
            </g>
            {isLine
              ? series.map((s, si) => (
                  <path key={s.name} d={s.values.map((v, i) => `${i ? 'L' : 'M'}${cx(i)},${y(v)}`).join(' ')} fill="none" stroke={SERIES[si]} strokeWidth={2} strokeLinejoin="round" />
                ))
              : chart.x.map((x, i) => {
                  let acc = 0
                  const segs = series.map((s, si) => {
                    const v = s.values[i] ?? 0
                    const top = y(acc + v)
                    const h = y(acc) - top
                    acc += v
                    const isTop = series.slice(si + 1).every((later) => !(later.values[i] ?? 0))
                    if (v <= 0) return null
                    // 2px surface gap between stacked segments; rounded data-end only on the top segment.
                    return <rect key={s.name} x={cx(i) - barW / 2} y={top} width={barW} height={Math.max(1, h - (acc - v > 0 ? 2 : 0))} rx={isTop ? Math.min(4, barW / 2) : 0} fill={SERIES[si]} />
                  })
                  return <g key={x}>{segs}</g>
                })}
            {hover !== null && isLine && <line x1={cx(hover)} x2={cx(hover)} y1={PAD.top} y2={PAD.top + ih} stroke="rgba(255,255,255,0.3)" />}
            {hover !== null && isLine && series.map((s, si) => <circle key={s.name} cx={cx(hover)} cy={y(s.values[hover] ?? 0)} r={4} fill={SERIES[si]} stroke="var(--surface)" strokeWidth={2} />)}
            <line className="baseline" x1={PAD.left} x2={W - PAD.right} y1={PAD.top + ih} y2={PAD.top + ih} />
            {chart.x.map((x, i) => (
              <rect key={x} x={PAD.left + step * i} y={PAD.top} width={step} height={ih} fill={selected === i ? 'rgba(255,255,255,0.06)' : 'transparent'} onMouseEnter={() => setHover(i)} onClick={onSelect ? () => onSelect(i) : undefined} style={onSelect ? { cursor: 'pointer' } : undefined} />
            ))}
          </svg>
          {tooltip}
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        {series.length > 1 ? (
          <div className="legend">
            {series.map((s, si) => <span key={s.name}><i style={{ background: SERIES[si] }} />{s.name}</span>)}
          </div>
        ) : <span />}
        <button type="button" className="link-button" onClick={() => setAsTable((v) => !v)}>{asTable ? 'Show chart' : 'Show as table'}</button>
      </div>
    </figure>
  )
}
