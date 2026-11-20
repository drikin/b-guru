import { describe, it, expect, vi, afterEach } from "vitest";
import { sakuraChat, BEAGLE_MODEL, SAKURA_MODEL } from "../sakura";

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

describe("ビーグルのモデル", () => {
  it("既定は DeepSeek-V4.1-Flash、ほかの機能は今までのモデル", () => {
    expect(BEAGLE_MODEL).toBe("preview/DeepSeek-V4.1-Flash-1017");
    expect(SAKURA_MODEL).toBe("gpt-oss-120b");
  });

  it("ビーグルのモデルが失敗したらその 1 回だけ既定のモデルでやり直す", async () => {
    process.env.SAKURA_AI_API_KEY = "test";
    const models = stubFetch((m) => m === BEAGLE_MODEL);
    const r = await sakuraChat({ model: BEAGLE_MODEL, messages: [{ role: "user", content: "hi" }] });
    expect(models).toEqual([BEAGLE_MODEL, SAKURA_MODEL]);
    expect(r.content).toBe(`ok:${SAKURA_MODEL}`);
    expect(r.model).toBe(SAKURA_MODEL);
  });

  it("ほかのモデルの失敗はやり直さない", async () => {
    process.env.SAKURA_AI_API_KEY = "test";
    const models = stubFetch(() => true);
    await expect(sakuraChat({ model: SAKURA_MODEL, messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(/503/);
    expect(models).toEqual([SAKURA_MODEL]);
  });
});
