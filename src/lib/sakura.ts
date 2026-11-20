/* AI relay helper for さくらのAI Engine (Sakura Internet).
 * OpenAI-compatible chat completions. 2026-11-19 から既定は DeepSeek-V4.1-Flash
 * （さくらでは preview）。失敗したらその 1 回だけ gpt-oss-120b（SAKURA_FALLBACK_MODEL）でやり直す。 The API key lives server-side only (env), never exposed
 * to the client.
 */
export const SAKURA_BASE =
  process.env.SAKURA_AI_BASE_URL || "https://api.ai.sakura.ad.jp/v1";
export const SAKURA_MODEL =
  process.env.SAKURA_AI_MODEL || "preview/DeepSeek-V4.1-Flash-1017";
/** 既定のモデルが失敗したときの代わり（正式提供のモデル）。 */
export const SAKURA_FALLBACK_MODEL =
  process.env.SAKURA_AI_FALLBACK_MODEL || "gpt-oss-120b";
/** 🐶 ビーグルのモデル。ふだんは SAKURA_MODEL と同じ（ビーグルだけ変えたいときは SAKURA_BEAGLE_MODEL）。 */
export const BEAGLE_MODEL = process.env.SAKURA_BEAGLE_MODEL || SAKURA_MODEL;
export const SAKURA_REASONING_MODEL =
  process.env.SAKURA_AI_REASONING_MODEL || "preview/DeepSeek-V4.1-Flash-1017";

/** Models the app is allowed to reach (blocks arbitrary model injection). */
export const ALLOWED_MODELS = new Set([
  "gpt-oss-120b",
  "preview/Qwen3.6-35B-A3B",
  "preview/Kimi-K2.6",
  "preview/gemma-4-31B-it",
  "preview/DeepSeek-V4.1-Flash-1017",
  "preview/GLM-5.3-Flash",
  SAKURA_MODEL,
  SAKURA_FALLBACK_MODEL,
  SAKURA_REASONING_MODEL,
  BEAGLE_MODEL,
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
async function sakuraChatOnce(opts: {
  model?: string;
  messages: ChatTurn[];
  temperature?: number;
  max_tokens?: number;
  /** 打ち切り（タイムアウト・新しい依頼で古い方を捨てるとき）。 */
  signal?: AbortSignal;
  /** 推論型モデル（gpt-oss など）の考える量。渡したときだけ送る（既存の呼び出しは送らない）。 */
  reasoning_effort?: "low" | "medium" | "high";
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
      ...(opts.reasoning_effort ? { reasoning_effort: opts.reasoning_effort } : {}),
    }),
    signal: opts.signal,
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

type SakuraChatOpts = Parameters<typeof sakuraChatOnce>[0];

/**
 * さくらの AI Engine を呼ぶ。失敗したら（打ち切り以外）その 1 回だけ SAKURA_FALLBACK_MODEL で
 * やり直す（preview のモデルが落ちたり空で返したりしても機能が止まらない）。
 */
export async function sakuraChat(opts: SakuraChatOpts): Promise<SakuraResult> {
  try {
    return await sakuraChatOnce(opts);
  } catch (e) {
    const used = opts.model && ALLOWED_MODELS.has(opts.model) ? opts.model : SAKURA_MODEL;
    if (used === SAKURA_FALLBACK_MODEL || opts.signal?.aborted) throw e;
    console.warn(`[sakura] ${used} failed, falling back to ${SAKURA_FALLBACK_MODEL}:`, String((e as Error)?.message ?? e).slice(0, 200));
    return await sakuraChatOnce({ ...opts, model: SAKURA_FALLBACK_MODEL });
  }
}
