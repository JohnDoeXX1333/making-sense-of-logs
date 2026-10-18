import type { Insights, Mover, Takeaway } from "../../shared/contract.ts";
import type { Dataset } from "./datasets.ts";
import { query } from "./db.ts";
import { bucketLabel, fromMs, type Range, rangeSql, toMs, UNIT_MS, type Unit, volumeSeries, type VolumeRow } from "./overview.ts";

// Rule-based insights for non-experts. Every number comes from SQL; sentences are fixed templates with thresholds,
// never model output, and they describe association only ("came from", "grew"), never cause.

const fmt = (n: number) => n.toLocaleString("en-US");
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);
// "all", "over 99.9%" or "42.5%": rounding must never turn 152,182 of 152,183 into "100%".
const shareText = (part: number, whole: number) => (part === whole ? "all" : pct(part, whole) >= 99.9 ? "over 99.9%" : `${pct(part, whole)}%`);

function duration(ms: number): string {
  const units: [number, string][] = [[UNIT_MS.day, "day"], [UNIT_MS.hour, "hour"], [UNIT_MS.minute, "minute"]];
  for (const [size, name] of units) {
    if (ms >= size && ms % size === 0) {
      const n = ms / size;
      return n === 1 ? name : `${n} ${name}s`;
    }
  }
  return `${Math.round(ms / UNIT_MS.minute)} minutes`;
}

const BAD_NODES = "('NULL', '-')";
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const name = (ds: Dataset, label: string) => (ds.kind === "builtin" ? label : `"${label}"`);

// Buckets whose alert count is far above the previous 24 buckets (missing buckets count as zero).
function findSpikes(rows: VolumeRow[], unit: Unit): string[] {
  if (rows.length < 7) return [];
  const step = UNIT_MS[unit];
  const byTime = new Map(rows.map((r) => [toMs(r.b), r.alerts]));
  const start = toMs(rows[0]!.b);
  const end = toMs(rows[rows.length - 1]!.b);
  if ((end - start) / step > 5000) return [];
  const series: { t: number; a: number }[] = [];
  for (let t = start; t <= end; t += step) series.push({ t, a: byTime.get(t) ?? 0 });
  const spikes: { t: number; a: number }[] = [];
  series.forEach((p, i) => {
    const base = series.slice(Math.max(0, i - 24), i).map((x) => x.a);
    if (base.length < 6 || p.a < 10) return;
    const mean = base.reduce((s, x) => s + x, 0) / base.length;
    const sd = Math.sqrt(base.reduce((s, x) => s + (x - mean) ** 2, 0) / base.length);
    if (p.a > mean + 3 * sd && p.a > 2 * mean) spikes.push(p);
  });
  return spikes
    .sort((x, y) => y.a - x.a || x.t - y.t)
    .slice(0, 8)
    .map((s) => bucketLabel(fromMs(s.t), unit));
}

async function movers(ds: Dataset, column: "label" | "node", range: Range, prevFrom: string): Promise<Mover[]> {
  const nodeFilter = column === "node" ? ` AND node NOT IN ${BAD_NODES}` : "";
  const { rows } = await query<{ k: string; now_n: number; old_n: number }>(
    `SELECT ${column} AS k, sum(CASE WHEN event_time >= $2::TIMESTAMP THEN 1 ELSE 0 END)::BIGINT AS now_n, sum(CASE WHEN event_time < $2::TIMESTAMP THEN 1 ELSE 0 END)::BIGINT AS old_n FROM ${ds.table} WHERE is_alert = true${nodeFilter} AND event_time >= $1::TIMESTAMP AND event_time < $3::TIMESTAMP GROUP BY 1`,
    [prevFrom, range.from, range.to],
  );
  const top = rows
    .map((r) => ({ key: r.k, now: r.now_n, before: r.old_n, delta: r.now_n - r.old_n }))
    .filter((m) => m.delta > 0)
    .sort((a, b) => b.delta - a.delta || a.key.localeCompare(b.key))
    .slice(0, 6);
  let first = new Map<string, string>();
  if (column === "label" && top.length) {
    const params = top.map((m) => m.key);
    const res = await query<{ k: string; first: string }>(
      `SELECT label AS k, min(event_time) AS first FROM ${ds.table} WHERE is_alert = true AND label IN (${params.map((_, i) => `$${i + 1}`).join(", ")}) GROUP BY 1`,
      params,
    );
    first = new Map(res.rows.map((r) => [r.k, r.first]));
  }
  return top.map((m) => ({ ...m, firstSeen: column === "label" ? (first.get(m.key) ?? null) : null }));
}

export async function insights(ds: Dataset, range: Range | null): Promise<Insights> {
  const { unit, rows: volume } = await volumeSeries(ds);
  const dataFrom = ds.timeFrom ?? (volume[0] ? volume[0].b : null);
  const dataTo = ds.timeTo ?? (volume.length ? fromMs(toMs(volume[volume.length - 1]!.b) + UNIT_MS[unit]) : null);
  const period: Range | null = range ?? (dataFrom && dataTo ? { from: dataFrom, to: dataTo } : null);
  const len = period ? toMs(period.to) - toMs(period.from) : 0;
  // Compare only with an equal earlier period that the data fully covers.
  const prevFrom = range && dataFrom && toMs(range.from) - len >= toMs(dataFrom) ? fromMs(toMs(range.from) - len) : null;

  const kp: unknown[] = [];
  const kWhere = prevFrom ? ` AND event_time >= $1::TIMESTAMP AND event_time < $3::TIMESTAMP` : rangeSql(period, kp);
  if (prevFrom && period) kp.push(prevFrom, period.from, period.to);
  const kSql = prevFrom
    ? `SELECT sum(CASE WHEN event_time >= $2::TIMESTAMP THEN 1 ELSE 0 END)::BIGINT AS n, sum(CASE WHEN event_time >= $2::TIMESTAMP AND is_alert THEN 1 ELSE 0 END)::BIGINT AS a, sum(CASE WHEN event_time < $2::TIMESTAMP THEN 1 ELSE 0 END)::BIGINT AS pn, sum(CASE WHEN event_time < $2::TIMESTAMP AND is_alert THEN 1 ELSE 0 END)::BIGINT AS pa FROM ${ds.table} WHERE true${kWhere}`
    : `SELECT count(*) AS n, sum(CASE WHEN is_alert THEN 1 ELSE 0 END)::BIGINT AS a, NULL AS pn, NULL AS pa FROM ${ds.table} WHERE true${kWhere}`;
  const k = (await query<{ n: number; a: number | null; pn: number | null; pa: number | null }>(kSql, kp)).rows[0]!;
  const lines = k.n ?? 0;
  const alerts = k.a ?? 0;
  const kpis = {
    lines,
    alerts,
    share: pct(alerts, lines),
    prevLines: prevFrom ? (k.pn ?? 0) : null,
    prevAlerts: prevFrom ? (k.pa ?? 0) : null,
    prevShare: prevFrom ? pct(k.pa ?? 0, k.pn ?? 0) : null,
  };

  const takeaways: Takeaway[] = [];
  const scope = range ? { from: range.from, to: range.to } : {};
  if (lines > 0) {
    takeaways.push({
      kind: "share",
      text: `${fmt(alerts)} of ${fmt(lines)} log lines (${kpis.share}%) in this period are alert lines.`,
      filter: { field: "all", value: "", alertsOnly: true, ...scope },
    });
  }

  // Peak bucket inside the period, with its main source when one node or pattern dominates.
  const inPeriod = period ? volume.filter((r) => toMs(r.b) >= toMs(period.from) && toMs(r.b) < toMs(period.to)) : volume;
  const peakRow = [...inPeriod].sort((a, b) => b.alerts - a.alerts || toMs(a.b) - toMs(b.b))[0];
  let peak: Insights["peak"] = null;
  if (peakRow && peakRow.alerts > 0) {
    const x = bucketLabel(peakRow.b, unit);
    peak = { x, alerts: peakRow.alerts };
    const counts = inPeriod.filter((r) => r.alerts > 0).map((r) => r.alerts).sort((a, b) => a - b);
    const median = counts[Math.floor((counts.length - 1) / 2)] ?? 0;
    const ratio = median > 0 ? peakRow.alerts / median : 0;
    const pStart = peakRow.b.slice(0, 19);
    const pEnd = fromMs(toMs(pStart) + UNIT_MS[unit]);
    const [node, label] = await Promise.all([
      query<{ k: string; n: number }>(`SELECT node AS k, count(*) AS n FROM ${ds.table} WHERE is_alert = true AND node NOT IN ${BAD_NODES} AND event_time >= $1::TIMESTAMP AND event_time < $2::TIMESTAMP GROUP BY 1 ORDER BY n DESC, k LIMIT 1`, [pStart, pEnd]),
      query<{ k: string; n: number }>(`SELECT label AS k, count(*) AS n FROM ${ds.table} WHERE is_alert = true AND event_time >= $1::TIMESTAMP AND event_time < $2::TIMESTAMP GROUP BY 1 ORDER BY n DESC, k LIMIT 1`, [pStart, pEnd]),
    ]);
    const parts = [`Alert lines peaked in the ${unit} of ${x}: ${fmt(peakRow.alerts)} lines${ratio >= 2 && counts.length >= 3 ? `, ${fmt(Math.round(ratio))} times the typical ${unit}` : ""}.`];
    const topNode = node.rows[0];
    // In uploads without hosts the node column holds the component, so it is not called a node there.
    if (topNode && pct(topNode.n, peakRow.alerts) >= 50) parts.push(`${cap(shareText(topNode.n, peakRow.alerts))} of them came from ${ds.kind === "builtin" ? `node ${topNode.k}` : `"${topNode.k}"`}.`);
    const topLabel = label.rows[0];
    if (topLabel && pct(topLabel.n, peakRow.alerts) >= 50) parts.push(`${cap(shareText(topLabel.n, peakRow.alerts))} ${ds.kind === "builtin" ? `were ${topLabel.k}` : `had the pattern "${topLabel.k}"`}.`);
    takeaways.push({ kind: "peak", text: parts.join(" "), filter: { field: "time", value: x, unit, alertsOnly: true } });
  }

  // The pattern that makes up most of the alerts in the period.
  if (alerts > 0) {
    const tp: unknown[] = [];
    const top = (await query<{ k: string; n: number }>(`SELECT label AS k, count(*) AS n FROM ${ds.table} WHERE is_alert = true${rangeSql(period, tp)} GROUP BY 1 ORDER BY n DESC, k LIMIT 1`, tp)).rows[0];
    if (top) {
      takeaways.push({
        kind: "concentration",
        text: `The most frequent alert ${ds.kind === "builtin" ? "category" : "pattern"} is ${name(ds, top.k)}: ${fmt(top.n)} lines, ${top.n === alerts ? "every alert line" : `${shareText(top.n, alerts)} of all alert lines`} in this period.`,
        filter: { field: "label", value: top.k, ...scope },
      });
    }
  }

  let mv: Insights["movers"] = null;
  if (range && prevFrom) {
    const [labels, nodes] = await Promise.all([movers(ds, "label", range, prevFrom), movers(ds, "node", range, prevFrom)]);
    mv = { labels, nodes };
    const lenText = duration(len);
    const grow = labels[0];
    if (!grow) {
      takeaways.push({ kind: "change", text: `No alert ${ds.kind === "builtin" ? "category" : "pattern"} grew compared with the previous ${lenText}.` });
    } else if (grow.firstSeen && toMs(grow.firstSeen) >= toMs(range.from)) {
      takeaways.push({ kind: "change", text: `${name(ds, grow.key)} appears for the first time in this period: ${fmt(grow.now)} alert lines.`, filter: { field: "label", value: grow.key, ...scope } });
    } else {
      takeaways.push({
        kind: "change",
        text: `${name(ds, grow.key)} grew the most: ${fmt(grow.before)} alert lines in the previous ${lenText}, ${fmt(grow.now)} in this period.`,
        filter: { field: "label", value: grow.key, ...scope },
      });
    }
    // Patterns seen for the first time anywhere in the data during this period (other than the one above).
    const fresh = labels.filter((m) => m !== grow && m.firstSeen && toMs(m.firstSeen) >= toMs(range.from));
    if (fresh.length) {
      takeaways.push({
        kind: "change",
        text: `First seen in this period: ${fresh.slice(0, 3).map((m) => `${name(ds, m.key)} (${fmt(m.now)} lines, from ${m.firstSeen!.slice(0, 16)})`).join(", ")}.`,
        filter: { field: "label", value: fresh[0]!.key, ...scope },
      });
    }
  }

  return {
    datasetId: ds.id,
    period: period ?? { from: "", to: "" },
    previous: prevFrom && period ? { from: prevFrom, to: period.from, length: duration(len) } : null,
    kpis,
    takeaways,
    peak,
    spikes: findSpikes(volume, unit),
    movers: mv,
  };
}
