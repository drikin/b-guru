import { describe, it, expect, vi, afterEach } from "vitest";
import { sakuraChat, BEAGLE_MODEL, SAKURA_MODEL, SAKURA_FALLBACK_MODEL, SAKURA_REASONING_MODEL } from "../sakura";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SAKURA_AI_API_KEY;
});

function stubFetch(fail: (model: string) => boolean) {
  const models: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    const model = JSON.parse(init.body).model as string;
    models.push(model);
    if (fail(model)) return new Response("busy", { status: 503 });
    return new Response(JSON.stringify({ choices: [{ message: { content: `ok:${model}` } }] }), { status: 200 });
  }));
  return models;
}

describe("さくらのモデル", () => {
  it("既定は全部 DeepSeek-V4.1-Flash、代わりは gpt-oss-120b", () => {
    expect(SAKURA_MODEL).toBe("preview/DeepSeek-V4.1-Flash-1017");
    expect(SAKURA_REASONING_MODEL).toBe("preview/DeepSeek-V4.1-Flash-1017");
    expect(BEAGLE_MODEL).toBe(SAKURA_MODEL);
    expect(SAKURA_FALLBACK_MODEL).toBe("gpt-oss-120b");
  });

  it("失敗したらその 1 回だけ gpt-oss-120b でやり直す（モデルを指定しなくても）", async () => {
    process.env.SAKURA_AI_API_KEY = "test";
    const models = stubFetch((m) => m === SAKURA_MODEL);
    const r = await sakuraChat({ messages: [{ role: "user", content: "hi" }] });
    expect(models).toEqual([SAKURA_MODEL, SAKURA_FALLBACK_MODEL]);
    expect(r.content).toBe(`ok:${SAKURA_FALLBACK_MODEL}`);
    expect(r.model).toBe(SAKURA_FALLBACK_MODEL);
  });

  it("gpt-oss-120b 自体の失敗はやり直さない", async () => {
    process.env.SAKURA_AI_API_KEY = "test";
    const models = stubFetch(() => true);
    await expect(sakuraChat({ model: SAKURA_FALLBACK_MODEL, messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(/503/);
    expect(models).toEqual([SAKURA_FALLBACK_MODEL]);
  });
});
