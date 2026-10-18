// Runs in a worker thread so a slow user or model supplied regex can be killed by the main thread.
import { readFileSync, writeFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { compileSpec, isAlert, messagePattern, parseLine, type FormatSpec } from "./logformat.ts";

export type WorkerTask =
  | { mode: "check"; lines: string[]; spec: FormatSpec }
  | { mode: "ingest"; rawPath: string; csvPath: string; spec: FormatSpec };

export interface ParseStats {
  total: number;
  matched: number;
  timed: number;
  alerts: number;
  firstTime: string | null;
  lastTime: string | null;
  preview: { line: number; time: string | null; level: string | null; component: string | null; host: string | null; message: string; matched: boolean }[];
  unmatchedExamples: string[];
}

export function splitLines(text: string): string[] {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const csv = (v: string | number | boolean | null) =>
  v === null ? "" : typeof v === "string" ? `"${v.replace(/"/g, '""')}"` : String(v);

function run(task: WorkerTask): ParseStats {
  const re = compileSpec(task.spec);
  const lines = task.mode === "check" ? task.lines : splitLines(readFileSync(task.rawPath, "utf8"));
  // Written synchronously at the end, so the file is complete when the worker reports success.
  const out: string[] | null = task.mode === "ingest" ? ["line_id,label,is_alert,epoch_s,event_time,node,midplane,event_type,component,level,message,raw_line,parse_status\n"] : null;
  const stats: ParseStats = { total: 0, matched: 0, timed: 0, alerts: 0, firstTime: null, lastTime: null, preview: [], unmatchedExamples: [] };
  let lastTime: string | null = null;
  lines.forEach((line, i) => {
    const p = parseLine(re, task.spec, line);
    stats.total++;
    if (p.matched) stats.matched++;
    else if (stats.unmatchedExamples.length < 5 && line.trim()) stats.unmatchedExamples.push(line.slice(0, 300));
    if (p.time) {
      stats.timed++;
      lastTime = p.time;
      stats.firstTime ??= p.time;
      stats.lastTime = p.time;
    }
    // A line without its own time (for example a stack trace continuation) inherits the previous line's time.
    const time = p.time ?? lastTime;
    const alert = isAlert(p.level, p.message);
    if (alert) stats.alerts++;
    if (stats.preview.length < 12) stats.preview.push({ line: i + 1, ...p });
    if (out) {
      const epoch = time ? Math.floor(Date.parse(`${time.slice(0, 19).replace(" ", "T")}Z`) / 1000) : null;
      const status = !p.matched ? "unmatched" : p.time || task.spec.timeFormat === "none" ? "ok" : "no_time";
      out.push([
        i + 1, alert ? messagePattern(p.message) : "-", alert, epoch, time, p.host ?? p.component ?? "-", null, "",
        p.component ?? "-", p.level ?? "-", p.message, line, status,
      ].map(csv).join(",") + "\n");
    }
  });
  if (out && task.mode === "ingest") writeFileSync(task.csvPath, out.join(""));
  return stats;
}

if (parentPort) {
  try {
    const stats = run(workerData as WorkerTask);
    parentPort.postMessage({ ok: true, stats });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: (err as Error).message });
  }
}
