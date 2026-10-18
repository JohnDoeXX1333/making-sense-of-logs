import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { EvidenceBundle, Finding, InvestigateEvent, InvestigateResponse, LogRow, Role, RoleView } from "../../shared/contract.ts";
import { fetchRows, query } from "./db.ts";
import { Evidence } from "./evidence.ts";
import { chat, chatJson, type Message } from "./llm.ts";
import { PRIORITY_FORMULA, priorities } from "./priority.ts";
import { TOOL_DESCRIPTIONS, TOOL_SCHEMAS, TOOLS, aggregate } from "./tools.ts";

const MAX_ROUNDS = 3;
const MAX_TOOL_CALLS = 6;
const ROLES: Role[] = ["engineer", "team_lead", "manager"];

const STANDARD_UNKNOWNS = [
  "BGL logs contain no ownership, customer, cost, downtime or SLA data, so those cannot be stated.",
];

let datasetSummary = "";

// Built once at startup from the database so the planner knows the real label names and time range.
export async function loadDatasetSummary() {
  const { rows } = await query<{ label: string; n: number }>(
    "SELECT label, count(*) AS n FROM bgl_logs WHERE is_alert = true GROUP BY label ORDER BY n DESC LIMIT 25",
  );
  const range = await query<{ first_t: string; last_t: string; n: number }>(
    "SELECT min(event_time) AS first_t, max(event_time) AS last_t, count(*) AS n FROM bgl_logs",
  );
  const r = range.rows[0]!;
  datasetSummary = `Dataset: Blue Gene/L supercomputer RAS log (Loghub BGL), ${r.n} lines from ${r.first_t.slice(0, 19)} to ${r.last_t.slice(0, 19)} log-local time (US Pacific). Each line has a time, node (e.g. R05-M1-N6-C:J05-U01; midplane = first two parts, e.g. R05-M1), component (KERNEL, APP, MMCS, DISCOVERY, HARDWARE, MONITOR, LINKCARD, CMCS, BGLMASTER), level (INFO, WARNING, ERROR, SEVERE, FATAL, FAILURE), an alert label ("-" means not an alert) and a free-text message. Alert labels with line counts: ${rows.map((x) => `${x.label} ${x.n}`).join(", ")}.`;
  return datasetSummary;
}

const toolSpecs = (Object.keys(TOOLS) as (keyof typeof TOOLS)[]).map((name) => {
  const { $schema: _ignored, ...parameters } = z.toJSONSchema(TOOL_SCHEMAS[name], { io: "input" }) as Record<string, unknown>;
  return { type: "function", function: { name, description: TOOL_DESCRIPTIONS[name], parameters } };
});

function plannerPrompt() {
  return `You are the evidence-gathering step of a log investigation agent. ${datasetSummary}

Call the tools to collect the evidence needed to answer the question for an engineer, a team lead and a manager. Rules:
- Use 2 to ${MAX_TOOL_CALLS} tool calls in total. Run independent calls in the same turn.
- Times are log-local; write them as "YYYY-MM-DD HH:MM:SS" with no timezone.
- For "what happened around X": searchLogs to find the event, then getContext on a returned lineId, then aggregate by midplane or node for spread.
- For recurring problems or trends: aggregate by label, then by week or midplane for the top labels.
- For priorities: aggregate by label (alertsOnly) and by week.
- Prefer exact label filters when the question names a category.
- When you have enough evidence, reply with the single word DONE and no tool calls. Do not write the answer yourself.`;
}

function formatRows(rows: LogRow[] | { line_id: number; event_time: string; node: string; label: string; level: string; message: string }[], max = 8) {
  return rows
    .slice(0, max)
    .map((r) =>
      "lineId" in r
        ? `line ${r.lineId} | ${r.time} | ${r.node} | ${r.label} ${r.level} | ${r.message}`
        : `line ${r.line_id} | ${r.event_time} | ${r.node} | ${r.label} ${r.level} | ${r.message}`,
    )
    .join("\n");
}

async function runTool(ev: Evidence, name: string, argsText: string): Promise<string> {
  const tool = TOOLS[name as keyof typeof TOOLS];
  if (!tool) return `error: unknown tool ${name}`;
  try {
    const args = JSON.parse(argsText || "{}");
    const result = await tool(ev, args);
    const facts = result.facts.map((f) => `${f.id} = ${f.value ?? ""}: ${f.statement}`).join("\n");
    const rows = "rows" in result && Array.isArray(result.rows) && result.rows.length && "line_id" in (result.rows[0] as object)
      ? `\nSample lines:\n${formatRows(result.rows as never)}`
      : "";
    return `Facts:\n${facts}${rows}`;
  } catch (err) {
    const msg = err instanceof z.ZodError ? z.prettifyError(err) : (err as Error).message;
    return `error: ${msg}`;
  }
}

async function gatherEvidence(ev: Evidence, question: string): Promise<number> {
  const messages: Message[] = [
    { role: "system", content: plannerPrompt() },
    { role: "user", content: question },
  ];
  let llmMs = 0;
  for (let round = 0; round < MAX_ROUNDS && ev.toolCalls.length < MAX_TOOL_CALLS; round++) {
    const { message, ms } = await chat({ messages, tools: toolSpecs, maxTokens: 2000 });
    llmMs += ms;
    const calls = message.tool_calls ?? [];
    if (calls.length === 0) break;
    messages.push({ role: "assistant", content: message.content ?? null, tool_calls: calls });
    const budget = MAX_TOOL_CALLS - ev.toolCalls.length;
    const results = await Promise.all(
      calls.map((c, i) => (i < budget ? runTool(ev, c.function.name, c.function.arguments) : Promise.resolve("skipped: tool budget used"))),
    );
    calls.forEach((c, i) => messages.push({ role: "tool", tool_call_id: c.id, content: results[i]! }));
  }
  return llmMs;
}

const ROLE_GUIDE: Record<Role, string> = {
  engineer:
    "Audience: the on-call engineer investigating the error. Give the concrete sequence of events with times, nodes, midplanes, components and labels, what came first, and the next checks to run. Separate what the logs show from hypotheses.",
  team_lead:
    "Audience: a team lead who needs to understand recurring problems. Focus on what keeps coming back, how often, where it is concentrated (midplanes, nodes, components), whether it is rising or falling, and which follow-up work to assign. Ownership is not in the logs.",
  manager:
    "Audience: a manager deciding what to prioritise. Use plain language without log jargon. Use the priority table: what ranks highest and why, using its inputs. State what the logs prove and what they cannot (impact on users, cost, downtime). Give at most 3 decisions.",
};

const VIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "summary", "findings", "unknowns", "recommendedActions"],
  properties: {
    headline: { type: "string" },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim", "evidenceIds", "status", "confidence"],
        properties: {
          claim: { type: "string" },
          evidenceIds: { type: "array", items: { type: "string" } },
          status: { type: "string", enum: ["observed", "inferred"] },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
      },
    },
    unknowns: { type: "array", items: { type: "string" } },
    recommendedActions: { type: "array", items: { type: "string" } },
  },
};

type DraftView = Omit<RoleView, "role" | "priorities">;

// Numbers in a claim must appear in the facts it cites; otherwise the claim cannot be "observed".
function checkFinding(f: Finding, facts: Map<string, string>): Finding | null {
  const ids = f.evidenceIds.filter((id) => facts.has(id));
  if (ids.length === 0) return null;
  const cited = ids.map((id) => facts.get(id)).join(" ");
  // Digits glued to letters or separators (N8, J05, 14:03) are names or time parts, not counts.
  const numbers = f.claim.match(/(?<![\w:.-])\d[\d,.]*/g) ?? [];
  const unsupported = numbers.some((n) => !cited.includes(n.replace(/[.,]+$/, "").replace(/,/g, "")));
  if (unsupported) return { ...f, evidenceIds: ids, status: "inferred", confidence: "low" };
  if (f.status === "inferred" && f.confidence === "high") return { ...f, evidenceIds: ids, confidence: "medium" };
  return { ...f, evidenceIds: ids };
}

async function writeView(role: Role, question: string, ev: Evidence, logs: LogRow[], prio: RoleView["priorities"]) {
  const facts = ev.facts.map((f) => `${f.id} = ${f.value ?? ""}: ${f.statement}`).join("\n");
  const priorityText =
    role === "manager" && prio?.length
      ? `\n\nPriority table (computed by the server, ${PRIORITY_FORMULA}):\n${prio.map((p) => `${p.factIds[0]}: ${p.label} score ${p.score}`).join("\n")}`
      : "";
  const prompt = `${ROLE_GUIDE[role]}

Question: ${question}

Facts from SereneDB (the only allowed source):
${facts || "(no facts were found)"}

Sample log lines:
${formatRows(logs, 25)}${priorityText}

Write the answer as JSON. Rules:
- Every finding cites one or more fact ids in evidenceIds. Every number in a claim must appear in a cited fact.
- status "observed" only when the cited facts state it directly; anything else is "inferred" with confidence medium or low.
- Never state a root cause, user impact, cost or owner that the facts do not contain. If the facts are not enough to answer, say so in the summary and list what is missing in unknowns.
- headline at most 10 words; summary at most 50 words; 3 or 4 findings, each claim at most 25 words; 1 to 3 recommendedActions of at most 20 words; at most 3 unknowns; plain English.`;
  const { value, ms } = await chatJson<DraftView>({
    messages: [
      { role: "system", content: `You explain log evidence for one audience. ${datasetSummary}` },
      { role: "user", content: prompt },
    ],
    jsonSchema: { name: "RoleView", schema: VIEW_SCHEMA },
    maxTokens: 3000,
    reasoningEffort: process.env.LLM_VIEW_EFFORT ?? "none",
  });
  const factText = new Map(ev.facts.map((f) => [f.id, `${f.value ?? ""} ${f.statement}`]));
  const findings = value.findings.map((f) => checkFinding(f, factText)).filter((f): f is Finding => f !== null);
  const view: RoleView = { role, ...value, findings, ...(role === "manager" ? { priorities: prio ?? [] } : {}) };
  return { view, ms };
}

export type Emit = (event: InvestigateEvent) => void;

// Runs one investigation. Events are emitted as they happen: each finished query, the evidence bundle,
// then each role view. The selected role is requested first because the provider handles one request at a time.
export async function investigate(question: string, emit: Emit = () => {}, firstRole: Role = "engineer"): Promise<InvestigateResponse> {
  const started = performance.now();
  const ev = new Evidence((call) => emit({ type: "tool", call }));
  ev.unknowns.push(...STANDARD_UNKNOWNS);
  let plannerMs = 0;
  try {
    plannerMs = await gatherEvidence(ev, question);
  } catch (err) {
    ev.unknowns.push(`The planning model failed (${(err as Error).message}); showing the default alert overview instead.`);
  }
  if (ev.facts.length === 0) {
    await aggregate(ev, { groupBy: "label", alertsOnly: true });
  }
  const touched = [...new Set(ev.toolCalls.map((t) => (t.args as { label?: string }).label).filter((l): l is string => !!l))];
  const prio = await priorities(ev, touched);
  const logs = await fetchRows(ev.lineIds());
  const bundle: EvidenceBundle = {
    queryId: randomUUID(),
    question,
    facts: ev.facts,
    logs,
    charts: ev.charts,
    toolCalls: ev.toolCalls,
    unknowns: ev.unknowns,
    searchMode: ev.searchMode,
  };
  emit({ type: "bundle", bundle });

  const order = [firstRole, ...ROLES.filter((r) => r !== firstRole)];
  const rolesStarted = performance.now();
  const views = {} as InvestigateResponse["views"];
  const write = async (role: Role) => {
    try {
      views[role] = (await writeView(role, question, ev, logs, prio)).view;
    } catch (err) {
      views[role] = { role, error: `Explanation unavailable: ${(err as Error).message}` };
    }
    emit({ type: "view", role, view: views[role] });
  };
  // The provider does not answer concurrent requests in order, so the selected role goes alone first.
  await write(order[0]!);
  await Promise.all(order.slice(1).map(write));
  const roleMs = Math.round(performance.now() - rolesStarted);
  console.error(JSON.stringify({ msg: "investigate timings", plannerMs, roleMs, toolCalls: ev.toolCalls.length }));

  return {
    bundle,
    views,
    timings: {
      dbMs: ev.toolCalls.reduce((s, t) => s + t.ms, 0),
      llmMs: plannerMs + roleMs,
      totalMs: Math.round(performance.now() - started),
    },
  };
}
