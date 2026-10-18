// Minimal OpenAI-compatible chat client for DeepSeek V4.1 Flash on Synthetic.
const BASE_URL = process.env.LLM_BASE_URL ?? "https://api.synthetic.new/openai/v1";
const MODEL = process.env.LLM_MODEL ?? "hf:deepseek-ai/DeepSeek-V4.1-Flash";
const API_KEY = process.env.LLM_API_KEY ?? process.env.SYNTHETIC_API_KEY;
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 60000);

export type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCallMsg[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolCallMsg {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatOptions {
  messages: Message[];
  tools?: unknown[];
  jsonSchema?: { name: string; schema: unknown };
  maxTokens?: number;
  reasoningEffort?: string;
}

export async function chat(opts: ChatOptions): Promise<{ message: Extract<Message, { role: "assistant" }>; ms: number }> {
  if (!API_KEY) throw new Error("LLM API key missing: set SYNTHETIC_API_KEY or LLM_API_KEY");
  const body: Record<string, unknown> = {
    model: MODEL,
    messages: opts.messages,
    max_tokens: opts.maxTokens ?? 3000,
    temperature: 0.2,
    reasoning_effort: opts.reasoningEffort ?? process.env.LLM_REASONING_EFFORT ?? "low",
  };
  if (opts.tools) {
    body.tools = opts.tools;
    body.tool_choice = "auto";
  }
  if (opts.jsonSchema) {
    body.response_format = { type: "json_schema", json_schema: { ...opts.jsonSchema, strict: true } };
  }
  const started = performance.now();
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { choices: { finish_reason: string; message: Extract<Message, { role: "assistant" }> }[]; usage?: unknown };
  const choice = data.choices[0];
  if (!choice) throw new Error("LLM returned no choices");
  if (choice.finish_reason === "length") throw new Error("LLM answer was cut off (max_tokens reached)");
  const ms = Math.round(performance.now() - started);
  console.error(JSON.stringify({ msg: "llm call", ms, usage: data.usage, effort: body.reasoning_effort }));
  return { message: choice.message, ms };
}

export async function chatJson<T>(opts: ChatOptions & { jsonSchema: { name: string; schema: unknown } }): Promise<{ value: T; ms: number }> {
  let lastError: unknown;
  let total = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { message, ms } = await chat(opts);
      total += ms;
      return { value: JSON.parse(message.content ?? "") as T, ms: total };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}
