import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import type { DatasetInfo, DetectResponse, ExampleQuestion, FormatSpecDto, Role } from "../../shared/contract.ts";
import { type Dataset, saveUpload, toInfo, uploadSummary } from "./datasets.ts";
import { query } from "./db.ts";
import { chatJson } from "./llm.ts";
import { compileSpec, TIME_FORMATS, type FormatSpec } from "./logformat.ts";
import { splitLines, type ParseStats, type WorkerTask } from "./parse-worker.ts";

// Uploaded files are written where the SereneDB container can read them (docker-compose mounts data/parquet at /imports).
const UPLOAD_DIR = new URL("../../data/parquet/uploads/", import.meta.url);
const CONTAINER_DIR = process.env.IMPORT_CONTAINER_DIR ?? "/imports/uploads";
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_LINES = 1_000_000;
const CHECK_LINES = 2000;
const FALLBACK: FormatSpec = { pattern: "^(?<message>.*)$", timeFormat: "none" };

interface PendingUpload {
  name: string;
  rawPath: string;
  lines: number;
  bytes: number;
  description: string;
}
const pending = new Map<string, PendingUpload>();
let ingesting = false;

function runWorker(task: WorkerTask, timeoutMs: number): Promise<ParseStats> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./parse-worker.ts", import.meta.url), { workerData: task });
    // A pathological regex cannot block the server: the worker is killed when the budget runs out.
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error(`parsing took longer than ${timeoutMs / 1000} s; the pattern is too slow`));
    }, timeoutMs);
    worker.once("message", (m: { ok: boolean; stats?: ParseStats; error?: string }) => {
      clearTimeout(timer);
      void worker.terminate();
      if (m.ok) resolve(m.stats!);
      else reject(new Error(m.error));
    });
    worker.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

const SPEC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pattern", "timeFormat", "description"],
  properties: {
    pattern: { type: "string" },
    timeFormat: { type: "string", enum: [...TIME_FORMATS] },
    description: { type: "string" },
  },
};

const DETECT_PROMPT = `You write one JavaScript regular expression that splits every line of a log file into fields.
Rules:
- Anchor with ^ and $. Use named groups only from: time, level, component, host, message. "message" is required and should capture the rest of the line, usually (?<message>.*).
- time: the whole timestamp text. level: severity word such as INFO, WARN, ERROR (only if the format has one). component: logger, class, process or module name; never a bare number such as a process id (skip numeric fields with \\d+ outside any group). host: machine or host name (only if present).
- Bracketed fields can contain nested brackets, for example [Worker[id=3]/pool:Scheduler@12]; use a pattern that still matches them, for example \\[(?<component>.*?)\\] - when " - " follows.
- Prefer simple, non-nested quantifiers such as \\S+, [^\\]]*, \\d+ so the pattern is fast. Do not use lookbehind.
- Every sample line should match, including lines with unusual spacing.
- timeFormat must describe the captured time text: iso = 2015-07-29 17:41:44,747 or 2015-07-29T17:41:44Z; yymmdd_hhmmss = 081109 203615; yy_slash = 17/06/09 20:10:40; syslog = Jun 14 15:16:01 (no year); apache = Sun Dec 04 04:47:44 2005; clf = 10/Oct/2000:13:55:36; epoch = unix seconds; none = no timestamp.
- description: one short sentence naming the format, for example "HDFS DataNode log with date, time, pid, level and class".`;

async function check(lines: string[], spec: FormatSpec) {
  const stats = await runWorker({ mode: "check", lines, spec }, 5000);
  const matchRate = stats.total ? stats.matched / stats.total : 0;
  const timeRate = stats.matched ? stats.timed / stats.matched : 0;
  return { stats, matchRate, timeRate };
}

export async function detect(text: string, name: string): Promise<DetectResponse> {
  const lines = splitLines(text);
  if (lines.length === 0) throw new Error("the file is empty");
  if (lines.length > MAX_LINES) throw new Error(`the file has ${lines.length} lines; the limit is ${MAX_LINES}`);
  const id = randomBytes(4).toString("hex");
  mkdirSync(UPLOAD_DIR, { recursive: true });
  const rawPath = new URL(`${id}.log`, UPLOAD_DIR).pathname;
  writeFileSync(rawPath, text);

  const sample = lines.filter((l) => l.trim()).slice(0, 40).map((l) => l.slice(0, 500));
  const checkLines = lines.slice(0, CHECK_LINES);
  let best: { spec: FormatSpec; description: string; matchRate: number; timeRate: number; stats: ParseStats } | null = null;
  let attempts = 0;
  let feedback = "";
  for (; attempts < 2; ) {
    attempts++;
    try {
      const { value } = await chatJson<{ pattern: string; timeFormat: FormatSpec["timeFormat"]; description: string }>({
        messages: [
          { role: "system", content: DETECT_PROMPT },
          { role: "user", content: `Sample lines:\n${sample.join("\n")}${feedback}` },
        ],
        jsonSchema: { name: "LogFormat", schema: SPEC_SCHEMA },
        maxTokens: 2000,
      });
      let spec: FormatSpec = { pattern: value.pattern, timeFormat: value.timeFormat, ...(value.timeFormat === "syslog" ? { year: new Date().getFullYear() } : {}) };
      compileSpec(spec);
      let r = await check(checkLines, spec);
      // If the model named the wrong time format, try the others with the same pattern.
      if (r.matchRate > 0 && r.timeRate < 0.8) {
        for (const tf of TIME_FORMATS.filter((f) => f !== "none" && f !== spec.timeFormat)) {
          const alt: FormatSpec = { ...spec, timeFormat: tf, ...(tf === "syslog" ? { year: new Date().getFullYear() } : {}) };
          const ar = await check(checkLines, alt);
          if (ar.timeRate > r.timeRate) {
            spec = alt;
            r = ar;
          }
        }
      }
      if (!best || r.matchRate + r.timeRate > best.matchRate + best.timeRate) best = { spec, description: value.description, ...r };
      // Retry below 98% so the model sees the failing lines; the best attempt is kept either way.
      if (r.matchRate >= 0.98 && (r.timeRate >= 0.8 || spec.timeFormat === "none")) break;
      feedback = `\n\nYour previous pattern ${JSON.stringify(spec.pattern)} matched ${Math.round(r.matchRate * 100)}% of lines and parsed the time in ${Math.round(r.timeRate * 100)}% of matched lines. Lines that did not match:\n${r.stats.unmatchedExamples.join("\n")}\nWrite a better pattern.`;
    } catch (err) {
      feedback = `\n\nYour previous answer failed: ${(err as Error).message}. Write a valid pattern.`;
    }
  }

  let fallback = false;
  if (!best || best.matchRate < 0.5) {
    const r = await check(checkLines, FALLBACK);
    best = { spec: FALLBACK, description: "Unrecognised format: each whole line is used as the message, without time", ...r };
    fallback = true;
  }
  pending.set(id, { name, rawPath, lines: lines.length, bytes: Buffer.byteLength(text), description: best.description });
  return {
    uploadId: id,
    name,
    lines: lines.length,
    bytes: Buffer.byteLength(text),
    spec: best.spec,
    description: best.description,
    matchRate: best.matchRate,
    timeRate: best.timeRate,
    preview: best.stats.preview,
    unmatchedExamples: best.stats.unmatchedExamples,
    attempts,
    fallback,
  };
}

const QUESTIONS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["role", "question"],
        properties: { role: { type: "string", enum: ["engineer", "team_lead", "manager"] }, question: { type: "string" } },
      },
    },
  },
};

async function suggestQuestions(summary: string): Promise<ExampleQuestion[]> {
  try {
    const { value } = await chatJson<{ questions: { role: Role; question: string }[] }>({
      messages: [
        { role: "system", content: "You suggest investigation questions about one log dataset. Use only names, labels and times that appear in the description." },
        { role: "user", content: `${summary}\n\nWrite exactly three short questions: one for an engineer about a specific error or incident (name a time or component), one for a team lead about recurring problems, one for a manager about priorities.` },
      ],
      jsonSchema: { name: "Questions", schema: QUESTIONS_SCHEMA },
      maxTokens: 1500,
    });
    return value.questions.slice(0, 3).map((q, i) => ({ id: `q${i + 1}`, role: q.role, question: q.question.slice(0, 300) }));
  } catch {
    return [
      { id: "q1", role: "engineer", question: "What are the most frequent errors and what happened around the first one?" },
      { id: "q2", role: "team_lead", question: "Which problems keep coming back, and where are they concentrated?" },
      { id: "q3", role: "manager", question: "What should we prioritise based on these logs, and what can the logs not tell us?" },
    ];
  }
}

const SCHEMA_SQL = (table: string) => `CREATE TABLE ${table} (line_id BIGINT, label VARCHAR, is_alert BOOLEAN, epoch_s BIGINT, event_time TIMESTAMP, node VARCHAR, midplane VARCHAR, event_type VARCHAR, component VARCHAR, level VARCHAR, message VARCHAR, raw_line VARCHAR, parse_status VARCHAR)`;

export async function ingest(uploadId: string, spec: FormatSpecDto, name?: string): Promise<DatasetInfo> {
  if (!/^[0-9a-f]{8}$/.test(uploadId)) throw new Error("bad upload id");
  const up = pending.get(uploadId);
  if (!up || !existsSync(up.rawPath)) throw new Error("upload not found; upload the file again");
  if (ingesting) throw new Error("another file is being loaded; try again in a moment");
  ingesting = true;
  try {
    compileSpec(spec);
    const csvPath = new URL(`${uploadId}.csv`, UPLOAD_DIR).pathname;
    await runWorker({ mode: "ingest", rawPath: up.rawPath, csvPath, spec }, 120_000);
    const table = `ds_${uploadId}`;
    const index = `ds_${uploadId}_idx`;
    await query(SCHEMA_SQL(table));
    await query(`COPY ${table} FROM '${CONTAINER_DIR}/${uploadId}.csv' (HEADER)`);
    await query(`CREATE INDEX ${index} ON ${table} USING inverted (line_id, message log_text, label, node, midplane, component, level, is_alert, event_time) INCLUDE (raw_line, epoch_s)`);
    await query(`VACUUM (REFRESH_TABLE) ${table}`);
    const displayName = (name ?? up.name).slice(0, 120);
    const s = await uploadSummary(table, displayName, up.description, spec.year);
    const ds: Dataset = {
      id: uploadId,
      name: displayName,
      kind: "upload",
      rows: s.range.n,
      timeFrom: s.timeFrom,
      timeTo: s.timeTo,
      notes: [
        `Format: ${up.description}.`,
        "Times are shown as written in the file; lines without their own time (for example stack traces) take the previous line's time.",
        ...(spec.year ? [`The timestamps have no year; ${spec.year} is assumed.`] : []),
        "Alert = level WARNING or worse, or an error keyword when a line has no level.",
        "Label = the message pattern of an alert line, with numbers and ids replaced by <*>.",
      ],
      examples: await suggestQuestions(s.summary),
      createdAt: new Date().toISOString(),
      table,
      index,
      summary: s.summary,
      spec,
    };
    saveUpload(ds);
    pending.delete(uploadId);
    return toInfo(ds);
  } finally {
    ingesting = false;
  }
}

