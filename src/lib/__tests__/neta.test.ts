/** Sending a post's article to BS ネタ帳 (lib/neta.ts). */
import { describe, it, expect } from "vitest";
import { netaRateOk, netaUrlOk, normalizeNetaInput, submitToNeta } from "../neta";

describe("what can be sent", () => {
  it("only outside http(s) articles, never a B-guru post link", () => {
    expect(netaUrlOk("https://kunkoku.jp/a?b=1")).toBe("https://kunkoku.jp/a?b=1");
    expect(netaUrlOk("http://example.com")).toBe("http://example.com/");
    expect(netaUrlOk("https://bsm.backspace.fm/#/post/1")).toBeNull();
    expect(netaUrlOk("javascript:alert(1)")).toBeNull();
    expect(netaUrlOk("https://user:pw@example.com")).toBeNull();
    expect(netaUrlOk(42)).toBeNull();
  });
  it("needs a title; trims; limits lengths", () => {
    expect(normalizeNetaInput({ url: "https://a.jp", title: "  " })).toEqual({ ok: false, error: "題名を入れてください" });
    expect(normalizeNetaInput({ url: "https://a.jp", title: " ソニー  新型 ", description: " " })).toEqual({
      ok: true, value: { url: "https://a.jp/", title: "ソニー 新型", description: null },
    });
    expect(normalizeNetaInput({ url: "https://a.jp", title: "あ".repeat(201) }).ok).toBe(false);
  });
});

describe("talking to ネタ帳", () => {
  const input = { url: "https://a.jp/", title: "t", description: null };
  const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  it("sends title, url and the member's name; reports the topic", async () => {
    let sentBody: any = null;
    const f = (async (_u: string, init: RequestInit) => { sentBody = JSON.parse(String(init.body)); return new Response(JSON.stringify({ id: 9 }), { status: 201 }); }) as unknown as typeof fetch;
    const r = await submitToNeta(input, "ドリキン", f);
    expect(r).toEqual({ status: 201, body: { ok: true, topicId: 9, site: "https://neta.backspace.fm" } });
    expect(sentBody).toEqual({ title: "t", url: "https://a.jp/", submitter: "ドリキン" });
  });
  it("tells who already posted it this week", async () => {
    const r = await submitToNeta(input, "x", reply(409, { code: "DUPLICATE_URL", existingTopic: { title: "既出", submitter: "mazzo" } }));
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "duplicate", existing: { title: "既出", submitter: "mazzo" } });
  });
  it("network failure → 502", async () => {
    const r = await submitToNeta(input, "x", (async () => { throw new Error("down"); }) as unknown as typeof fetch);
    expect(r.status).toBe(502);
  });
});

describe("web rate limit", () => {
  it("20 an hour", () => {
    const t = 1_000_000;
    for (let i = 0; i < 20; i++) expect(netaRateOk("a@x", t + i)).toBe(true);
    expect(netaRateOk("a@x", t + 21)).toBe(false);
    expect(netaRateOk("a@x", t + 3600_001)).toBe(true);
  });
});
