/** ✉️ 簡易 DM の純粋な部分（DB なし）: 本文の検証、DTO（メールなし・見る人ごと）、通知の中身、capabilities、機能フラグ。 */
import { describe, it, expect, afterEach } from "vitest";
import { normalizeDmBody, toDmDto, validPeerId, normalizeDmClientId, dmCapability, dmEnabledFor, DM_MAX_BODY } from "../dm";
import { buildDmPayload, dmNotificationText } from "../push-notify";
import { toFcmData } from "../fcm";
import { dmListApi } from "../dm-api";

const A = "a@example.com";
const B = "b@example.com";
const ids = new Map([
  [A, "userAAAAAAAA"],
  [B, "userBBBBBBBB"],
]);
const row = { id: 7, sender_email: A, recipient_email: B, body: "やあ", created_at: "2026-10-24T01:02:03Z" };

describe("normalizeDmBody", () => {
  it("改行をそろえて前後を落とす、空・長すぎ・文字列以外は不可", () => {
    expect(normalizeDmBody("  a\r\nb  ")).toEqual({ ok: true, body: "a\nb" });
    expect(normalizeDmBody("   ")).toEqual({ ok: false, error: "empty" });
    expect(normalizeDmBody(undefined)).toEqual({ ok: false, error: "empty" });
    expect(normalizeDmBody({ toString: () => "x" })).toEqual({ ok: false, error: "empty" });
    expect(normalizeDmBody("x".repeat(DM_MAX_BODY))).toMatchObject({ ok: true });
    expect(normalizeDmBody("x".repeat(DM_MAX_BODY + 1))).toEqual({ ok: false, error: "too long" });
    expect(DM_MAX_BODY).toBe(1000);
  });
});

describe("toDmDto", () => {
  it("送り主から見ると is_author・相手は受け取った人、client_id は送り主だけ", () => {
    const mine = toDmDto(row, A, ids, "cid");
    expect(mine).toEqual({
      id: 7,
      from_id: "userAAAAAAAA",
      to_id: "userBBBBBBBB",
      peer_id: "userBBBBBBBB",
      body: "やあ",
      created_at: "2026-10-24T01:02:03.000Z",
      is_author: true,
      client_id: "cid",
    });
    const theirs = toDmDto(row, B, ids, "cid");
    expect(theirs).toMatchObject({ is_author: false, peer_id: "userAAAAAAAA" });
    expect(theirs.client_id).toBeUndefined();
    expect(JSON.stringify([mine, theirs])).not.toContain("@");
  });
  it("大文字のメールでも同じ人", () => {
    expect(toDmDto(row, "A@Example.com ", ids).is_author).toBe(true);
  });
});

describe("入力の形", () => {
  it("相手の ID・client_id", () => {
    expect(validPeerId("abcDEF123456")).toBe(true);
    expect(validPeerId("../x")).toBe(false);
    expect(validPeerId("")).toBe(false);
    expect(validPeerId(12)).toBe(false);
    expect(normalizeDmClientId("c-1_2")).toBe("c-1_2");
    expect(normalizeDmClientId("bad id")).toBeNull();
  });
});

describe("通知", () => {
  it("中身は ids と決まった文言だけ（本文・名前・メールは入れない）。message_id は使わない", () => {
    const p = buildDmPayload(42, "userAAAAAAAA");
    expect(p.aps.alert).toEqual({ title: "B-guru DM", body: "DM が届きました" });
    expect(p.aps["mutable-content"]).toBe(1);
    expect(p.aps["thread-id"]).toBe("dm-userAAAAAAAA");
    expect(p).toMatchObject({ kind: "dm", dm_id: 42, peer_id: "userAAAAAAAA" });
    expect("message_id" in p).toBe(false); // DM 以前のアプリがチャットの発言を読みにいかない
    expect(toFcmData(p)).toEqual({ kind: "dm", dm_id: "42", peer_id: "userAAAAAAAA" });
  });
  it("端末が読めたときの文言: 「〇〇さんからの DM」、本文は 240 字で切る", () => {
    expect(dmNotificationText("ねこ", "やあ")).toEqual({ title: "ねこさんからの DM", body: "やあ" });
    expect(dmNotificationText(null, "x").title).toBe("会員さんからの DM");
    const long = dmNotificationText("ねこ", "あ".repeat(300)).body;
    expect(long).toHaveLength(241);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("機能フラグ DM_ENABLED", () => {
  const prev = process.env.DM_ENABLED;
  afterEach(() => {
    if (prev === undefined) delete process.env.DM_ENABLED;
    else process.env.DM_ENABLED = prev;
  });
  it("未設定は誰にも、メールの列挙はその人だけ、1 は全員", () => {
    delete process.env.DM_ENABLED;
    expect(dmEnabledFor(A)).toBe(false);
    process.env.DM_ENABLED = "x@example.com, A@example.com";
    expect(dmEnabledFor(A)).toBe(true);
    expect(dmEnabledFor(B)).toBe(false);
    process.env.DM_ENABLED = "1";
    expect(dmEnabledFor(B)).toBe(true);
    expect(dmEnabledFor(null)).toBe(false);
  });
  it("対象外の人の API は 404（DB に触らない）", async () => {
    delete process.env.DM_ENABLED;
    const r = await dmListApi({ email: A, userId: "userAAAAAAAA" });
    expect(r.status).toBe(404);
  });
  it("capabilities の features.dm: 送れるのは chat スコープがあるときだけ", () => {
    expect(dmCapability(true, ["read", "chat"])).toMatchObject({ enabled: true, send: true, path: "/api/agent/dm", max_body: 1000, ttl_hours: 24, rate_limit_per_hour: 60 });
    expect(dmCapability(true, ["read"]).send).toBe(false);
    expect(dmCapability(false, ["chat"])).toMatchObject({ enabled: false, send: false });
  });
});
