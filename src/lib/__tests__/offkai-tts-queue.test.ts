/**
 * 🍻 チャットの読み上げの順番（Web の speechSynthesis。docs/offkai-spec.md「チャットの読み上げ」）:
 *  - 終わりの知らせが来なくても、見積もった時間で次へ進む（止まったままにならない）
 *  - 端末の中の日本語の声だけ（ネットの声しか無ければ読まない）
 *  - 止めたあとに遅れて届く知らせで数がずれない・同じ発言は 2 度読まない
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const offkai = { current: { id: 1 } as unknown, audio: "listening" as string };
const offkaiSubs = new Set<() => void>();
vi.mock("../offkai-client", () => ({
  getSnapshot: () => offkai,
  subscribe: (l: () => void) => (offkaiSubs.add(l), () => offkaiSubs.delete(l)),
}));

type U = { text: string; voice?: unknown; onend?: () => void; onerror?: () => void; volume?: number; lang?: string };
const spokenTexts: U[] = [];
let voices: { lang: string; localService: boolean; name: string }[] = [];
const synth = {
  speak: (u: U) => spokenTexts.push(u),
  cancel: vi.fn(),
  getVoices: () => voices,
  addEventListener: vi.fn(),
};

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  spokenTexts.length = 0;
  offkai.current = { id: 1 };
  offkai.audio = "listening";
  voices = [{ lang: "ja-JP", localService: true, name: "Kyoko" }];
  const store: Record<string, string> = {};
  vi.stubGlobal("localStorage", { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => (store[k] = v) });
  vi.stubGlobal("window", { speechSynthesis: synth });
  vi.stubGlobal("SpeechSynthesisUtterance", function (this: U, text: string) { this.text = text; });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const load = () => import("../offkai-tts");
const msg = (id: number, body: string) => ({ id, authorName: "A", body });

describe("読み上げの順番", () => {
  it("1 件ずつ、終わったら次", async () => {
    const t = await load();
    t.speakChat(msg(1, "一"));
    t.speakChat(msg(2, "二"));
    expect(spokenTexts.map((u) => u.text)).toEqual(["Aさん、一"]);
    spokenTexts[0].onend?.();
    expect(spokenTexts.map((u) => u.text)).toEqual(["Aさん、一", "Aさん、二"]);
  });

  it("終わりの知らせが来なくても次へ進む", async () => {
    const t = await load();
    t.speakChat(msg(1, "一"));
    t.speakChat(msg(2, "二"));
    vi.advanceTimersByTime(Array.from("Aさん、一").length * 200 + 5001);
    expect(spokenTexts.map((u) => u.text)).toEqual(["Aさん、一", "Aさん、二"]);
  });

  it("同じ発言は 2 度読まない", async () => {
    const t = await load();
    t.speakChat(msg(1, "一"));
    spokenTexts[0].onend?.();
    t.speakChat(msg(1, "一"));
    expect(spokenTexts).toHaveLength(1);
  });

  it("ネットの声しか無ければ読まない", async () => {
    voices = [{ lang: "ja-JP", localService: false, name: "Google 日本語" }];
    const t = await load();
    t.speakChat(msg(1, "一"));
    expect(spokenTexts).toHaveLength(0);
  });

  it("止めたあとに遅れて届いた知らせは無視、オフ会の音声から出たら止める", async () => {
    const t = await load();
    t.speakChat(msg(1, "一"));
    t.speakChat(msg(2, "二"));
    const first = spokenTexts[0];
    t.setTtsEnabled(false); // 止める（待ちも捨てる）
    t.setTtsEnabled(true);
    first.onerror?.(); // 遅れて届く
    t.speakChat(msg(3, "三"));
    expect(spokenTexts.filter((u) => u.text).map((u) => u.text)).toEqual(["Aさん、一", "Aさん、三"]);
    offkai.audio = "idle";
    for (const l of offkaiSubs) l();
    expect(synth.cancel).toHaveBeenCalled();
    t.speakChat(msg(4, "四"));
    expect(spokenTexts.filter((u) => u.text).map((u) => u.text)).toEqual(["Aさん、一", "Aさん、三"]);
  });
});
