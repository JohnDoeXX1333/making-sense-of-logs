import type { PriorityItem } from "../../shared/contract.ts";
import { query } from "./db.ts";
import type { Evidence } from "./evidence.ts";
import { DATA_END, DATA_START } from "./tools.ts";

// Transparent manager priority. Every input is a database count; the weights are fixed and shown in the UI.
export const PRIORITY_FORMULA =
  "score = 100 x (0.30 x events + 0.25 x nodes + 0.20 x activeDays + 0.15 x fatalShare + 0.10 x trend), each input scaled 0..1 against the largest category (events and nodes on a log scale)";

function shift(t: string, ms: number) {
  return new Date(new Date(`${t.replace(" ", "T")}Z`).getTime() + ms).toISOString().slice(0, 19).replace("T", " ");
}

// Returns the top categories plus any category the investigation itself touched, so the manager sees where it ranks.
export async function priorities(ev: Evidence, extraLabels: string[] = [], from = DATA_START, to = DATA_END, top = 5): Promise<PriorityItem[]> {
  const span = new Date(`${to.replace(" ", "T")}Z`).getTime() - new Date(`${from.replace(" ", "T")}Z`).getTime();
  const recentStart = shift(to, -span / 4);
  const previousStart = shift(to, -span / 2);
  const sql = `SELECT label, count(*) AS events, count(DISTINCT CASE WHEN node NOT IN ('NULL', '-') THEN node END) AS nodes, count(DISTINCT date_trunc('day', event_time)) AS days, sum(CASE WHEN level IN ('FATAL', 'FAILURE') THEN 1 ELSE 0 END)::BIGINT AS fatal, sum(CASE WHEN event_time >= $3::TIMESTAMP THEN 1 ELSE 0 END)::BIGINT AS recent, sum(CASE WHEN event_time >= $4::TIMESTAMP AND event_time < $3::TIMESTAMP THEN 1 ELSE 0 END)::BIGINT AS previous, min(line_id) AS first_id, max(line_id) AS last_id FROM bgl_logs WHERE is_alert = true AND event_time >= $1::TIMESTAMP AND event_time < $2::TIMESTAMP GROUP BY label`;
  const { rows, ms } = await query<{ label: string; events: number; nodes: number; days: number; fatal: number; recent: number; previous: number; first_id: number; last_id: number }>(
    sql,
    [from, to, recentStart, previousStart],
  );
  const call = ev.addToolCall({ tool: "aggregate", args: { purpose: "manager priority", from, to, recentStart, previousStart }, sql, rowCount: rows.length, ms });
  if (rows.length === 0) return [];
  const maxEvents = Math.max(...rows.map((r) => r.events));
  const maxNodes = Math.max(...rows.map((r) => r.nodes));
  const maxDays = Math.max(...rows.map((r) => r.days));
  const scored = rows.map((r) => {
    const trendPct = r.previous > 0 ? Math.round(((r.recent - r.previous) / r.previous) * 100) : null;
    const trend = trendPct === null ? (r.recent > 0 ? 1 : 0) : Math.min(1, Math.max(0, (trendPct + 100) / 200));
    const fatalShare = r.fatal / r.events;
    const score =
      100 *
      (0.3 * (Math.log1p(r.events) / Math.log1p(maxEvents)) +
        0.25 * (Math.log1p(r.nodes) / Math.log1p(maxNodes)) +
        0.2 * (r.days / maxDays) +
        0.15 * fatalShare +
        0.1 * trend);
    return { r, trendPct, fatalShare, score: Math.round(score) };
  });
  scored.sort((a, b) => b.score - a.score);
  const picked = scored.filter((s, i) => i < top || extraLabels.includes(s.r.label));
  return picked.map(({ r, trendPct, fatalShare, score }) => {
    const rank = scored.findIndex((s) => s.r.label === r.label) + 1;
    const trendText = trendPct === null ? (r.recent > 0 ? `${r.recent} lines in the last quarter of the period after none in the quarter before` : "no lines in the last half of the period") : `${trendPct > 0 ? "+" : ""}${trendPct}% last quarter vs the quarter before`;
    const fact = ev.addFact(
      call.id,
      `${r.label}: ${r.events} alert lines on ${r.nodes} nodes over ${r.days} active days, ${Math.round(fatalShare * 100)}% FATAL/FAILURE, trend ${trendText}; priority score ${score}, rank ${rank} of ${scored.length} alert categories`,
      score,
      [r.first_id, r.last_id],
    );
    return {
      label: r.label,
      score,
      inputs: { events: r.events, nodes: r.nodes, activeDays: r.days, trendPct, fatalShare: Math.round(fatalShare * 100) / 100 },
      factIds: [fact.id],
    };
  });
}
