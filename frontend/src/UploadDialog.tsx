import { useEffect, useRef, useState, type DragEvent } from 'react'
import type { DatasetInfo, DetectResponse } from '../../shared/contract.ts'

const MAX_BYTES = 50 * 1024 * 1024
const pct = (n: number) => `${Math.round(n * 100)}%`

type Step = 'pick' | 'detecting' | 'review' | 'loading'

export function UploadDialog({ open, onClose, onLoaded }: { open: boolean; onClose: () => void; onLoaded: (ds: DatasetInfo) => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [step, setStep] = useState<Step>('pick')
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState('')
  const [detected, setDetected] = useState<DetectResponse | null>(null)
  const [year, setYear] = useState(new Date().getFullYear())
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) {
      setStep('pick')
      setFile(null)
      setError('')
      setDetected(null)
      d.showModal()
    }
    if (!open && d.open) d.close()
  }, [open])

  function choose(f: File | undefined) {
    setError('')
    if (!f) return
    if (f.size > MAX_BYTES) {
      setError(`The file is ${(f.size / 1024 / 1024).toFixed(1)} MB; the limit is 50 MB.`)
      return
    }
    setFile(f)
  }

  async function detectFormat() {
    if (!file) {
      setError('Choose a log file first.')
      return
    }
    setStep('detecting')
    setError('')
    try {
      const res = await fetch(`/api/datasets/detect?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: await file.text() })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      setDetected(body as DetectResponse)
      if ((body as DetectResponse).spec.year) setYear((body as DetectResponse).spec.year!)
      setStep('review')
    } catch (err) {
      setError((err as Error).message)
      setStep('pick')
    }
  }

  async function load() {
    if (!detected) return
    setStep('loading')
    setError('')
    try {
      const spec = { ...detected.spec, ...(detected.spec.timeFormat === 'syslog' ? { year } : {}) }
      const res = await fetch(`/api/datasets/${detected.uploadId}/ingest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spec, name: detected.name }) })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      onLoaded(body as DatasetInfo)
    } catch (err) {
      setError((err as Error).message)
      setStep('review')
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    setDragging(false)
    choose(e.dataTransfer.files[0])
  }

  const busy = step === 'detecting' || step === 'loading'

  return (
    <dialog ref={ref} className="modal" onClose={onClose} onCancel={(e) => { if (busy) e.preventDefault() }} aria-labelledby="upload-title">
      <div className="drawer-head">
        <div>
          <div className="eyebrow">Bring your own logs</div>
          <h2 id="upload-title">Upload a log file</h2>
        </div>
        <button type="button" className="close" onClick={onClose} aria-label="Close upload" disabled={busy}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.6" /></svg>
        </button>
      </div>
      <div className="drawer-body">
        {(step === 'pick' || step === 'detecting') && (
          <>
            <label
              className={`dropzone${dragging ? ' dragging' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <input type="file" accept=".log,.txt,text/plain" onChange={(e) => choose(e.target.files?.[0])} disabled={busy} aria-describedby="upload-help" />
              <strong>{file ? file.name : 'Drop a .log or .txt file here, or choose one'}</strong>
              <span id="upload-help">{file ? `${(file.size / 1024).toFixed(0)} KB` : 'Plain text, one event per line, up to 50 MB.'}</span>
            </label>
            <p className="privacy">
              The first 40 lines are sent to the language model (DeepSeek through Synthetic) to recognise the format, and investigations later send facts and sample lines. Only upload logs you are allowed to share with an external AI service.
            </p>
            {error && <p className="field-error" role="alert">{error}</p>}
            <div className="dialog-actions">
              <button type="button" className="btn-primary" onClick={detectFormat} disabled={busy}>
                {step === 'detecting' ? <><span className="spinner" aria-hidden="true" /> Recognising the format</> : 'Recognise format'}
              </button>
            </div>
          </>
        )}

        {(step === 'review' || step === 'loading') && detected && (
          <>
            <dl className="kv">
              <dt>Format</dt><dd>{detected.description}</dd>
              <dt>Lines</dt><dd>{detected.lines.toLocaleString('en-US')}</dd>
              <dt>Lines matched</dt><dd>{pct(detected.matchRate)} of the first {Math.min(2000, detected.lines).toLocaleString('en-US')}{detected.attempts > 1 ? `, after ${detected.attempts} attempts` : ''}</dd>
              <dt>Times parsed</dt><dd>{detected.spec.timeFormat === 'none' ? 'no timestamp' : `${pct(detected.timeRate)} (${detected.spec.timeFormat})`}</dd>
              <dt>Pattern</dt><dd className="mono" style={{ fontSize: 12 }}>{detected.spec.pattern}</dd>
            </dl>
            {detected.fallback && <div className="error-box">No reliable pattern was found. Each whole line will be used as the message, without time, level or component.</div>}
            {detected.spec.timeFormat === 'syslog' && (
              <div>
                <label htmlFor="year" className="section-title" style={{ display: 'block' }}>Year for timestamps (the file has no year)</label>
                <input id="year" className="year-input" type="number" inputMode="numeric" min={1970} max={2100} value={year} onChange={(e) => setYear(Number(e.target.value))} />
              </div>
            )}
            <div>
              <h3 className="section-title">Preview of the parsed lines</h3>
              <div className="table-wrap">
                <table className="log-table">
                  <thead><tr><th scope="col">Line</th><th scope="col">Time</th><th scope="col">Level</th><th scope="col">Component</th><th scope="col">Host</th><th scope="col">Message</th></tr></thead>
                  <tbody>
                    {detected.preview.map((p) => (
                      <tr key={p.line}>
                        <td className="mono">{p.line}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{p.time ?? <em>none</em>}</td>
                        <td>{p.level ?? ''}</td>
                        <td className="mono">{p.component ?? ''}</td>
                        <td className="mono">{p.host ?? ''}</td>
                        <td className="msg">{p.matched ? p.message : <em>not matched: {p.message}</em>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            {detected.unmatchedExamples.length > 0 && (
              <div>
                <h3 className="section-title">Lines that did not match (kept as whole lines)</h3>
                <pre className="sql">{detected.unmatchedExamples.join('\n')}</pre>
              </div>
            )}
            {error && <p className="field-error" role="alert">{error}</p>}
            <div className="dialog-actions">
              <button type="button" className="btn-secondary" onClick={() => setStep('pick')} disabled={busy}>Choose another file</button>
              <button type="button" className="btn-primary" onClick={load} disabled={busy}>
                {step === 'loading' ? <><span className="spinner" aria-hidden="true" /> Loading into SereneDB</> : `Load ${detected.lines.toLocaleString('en-US')} lines into SereneDB`}
              </button>
            </div>
          </>
        )}
      </div>
    </dialog>
  )
}
