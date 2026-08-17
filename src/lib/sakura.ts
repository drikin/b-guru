/* AI relay helper for さくらのAI Engine (Sakura Internet).
 * OpenAI-compatible chat completions. Base model is the fast gpt-oss-120b
 * (default). A reasoning model (preview/Qwen3.6-35B-A3B) is available via
 * per-request override. The API key lives server-side only (env), never exposed
 * to the client.
 */
export const SAKURA_BASE =
  process.env.SAKURA_AI_BASE_URL || "https://api.ai.sakura.ad.jp/v1";
export const SAKURA_MODEL = process.env.SAKURA_AI_MODEL || "gpt-oss-120b";
export const SAKURA_REASONING_MODEL =
  process.env.SAKURA_AI_REASONING_MODEL || "preview/Qwen3.6-35B-A3B";

/** Models the app is allowed to reach (blocks arbitrary model injection). */
export const ALLOWED_MODELS = new Set([
  "gpt-oss-120b",
  "preview/Qwen3.6-35B-A3B",
  "preview/Kimi-K2.6",
  "preview/gemma-4-31B-it",
]);

export interface ChatTurn {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface SakuraResult {
  content: string;
  reasoning?: string;
  model: string;
  usage?: unknown;
}

/**
 * Call さくらのAI Engine chat completions. `model` is allow-listed; if absent
 * or disallowed it falls back to the default fast model. Throws on missing key
 * / network / non-200 so the caller can 5xx.
 */
export async function sakuraChat(opts: {
  model?: string;
  messages: ChatTurn[];
  temperature?: number;
  max_tokens?: number;
}): Promise<SakuraResult> {
  const apiKey = process.env.SAKURA_AI_API_KEY;
  if (!apiKey) throw new Error("SAKURA_AI_API_KEY が設定されていません");

  const model =
    opts.model && ALLOWED_MODELS.has(opts.model) ? opts.model : SAKURA_MODEL;

  const res = await fetch(`${SAKURA_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.max_tokens ?? 1500,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`さくらのAI Engine error ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const msg = data?.choices?.[0]?.message;
  const content: string = (msg?.content ?? "").trim();
  if (!content) {
    throw new Error("さくらのAI Engine が空の応答を返しました");
  }
  return { content, reasoning: msg?.reasoning, model, usage: data?.usage };
}
