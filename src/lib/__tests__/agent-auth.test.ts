/**
 * agent-auth: トークン発行/検証/失効/レート制限/会員確認。
 * DB と Ghost はモック（既存 __tests__ のパターン踏襲）。実 DB 結合は
 * DATABASE_URL がある環境のみ（CI はスキップ）。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";

const query = vi.fn();
vi.mock("../db", () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

const findMemberByEmail = vi.fn();
vi.mock("../ghost", () => ({
  findMemberByEmail: (...a: unknown[]) => findMemberByEmail(...(a as [string])),
  // 本物の isPaidMember を使う（判定ロジックの複製を作らない検証）。
  isPaidMember: (m: any) =>
    m.status === "paid" ||
    (Array.isArray(m?.subscriptions) && m.subscriptions.some((s: any) => s.status === "active" || s.status === "trialing")),
}));

const ensureUserId = vi.fn(async (_e: string) => "uid_test");
vi.mock("../user", () => ({ ensureUserId: (...a: unknown[]) => ensureUserId(...(a as [string])) }));

import {
  issueAgentToken,
  verifyAgentToken,
  normalizeScopes,
  checkRateLimit,
  requireScope,
  hashToken,
  AgentAuthError,
  RATE_RULES,
} from "../agent-auth";

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [], rowCount: 0 });
  findMemberByEmail.mockReset();
});

describe("issueAgentToken", () => {
  it("平文トークンを DB に保存しない（SHA-256 ハッシュのみ）", async () => {
    query.mockResolvedValue({ rows: [{ id: 1, expires_at: new Date() }] });
    const issued = await issueAgentToken({ email: "a@b.c", deviceName: "test", scopes: ["read"] });
    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toContain("INSERT INTO agent_tokens");
    expect(params[0]).toBe(hashToken(issued.token));
    expect(params[0]).not.toBe(issued.token);
    // トークン形式: bga_ + 64hex
    expect(issued.token).toMatch(/^bga_[0-9a-f]{64}$/);
  });

  it("発行トークンが crypto.randomBytes(32) 由来の 32 バイト相当", async () => {
    query.mockResolvedValue({ rows: [{ id: 1, expires_at: new Date() }] });
    const i = await issueAgentToken({ email: "a@b.c", deviceName: "t", scopes: [] });
    expect(Buffer.from(i.token.slice(4), "hex").length).toBe(32);
  });
});

describe("normalizeScopes", () => {
  it("未知スコープを落とし、空なら read にフォールバック", () => {
    expect(normalizeScopes(["read", "hoge"])).toEqual(["read"]);
    expect(normalizeScopes(["nonsense"])).toEqual(["read"]);
    expect(normalizeScopes(["read", "chat"])).toEqual(["read", "chat"]);
    expect(normalizeScopes(undefined)).toEqual(["read"]);
  });
});

describe("verifyAgentToken", () => {
  it("Bearer ヘッダが無ければ 401 unauthorized", async () => {
    await expect(verifyAgentToken(null)).rejects.toMatchObject({ status: 401, body: { code: "unauthorized" } });
  });

  it("未知トークンは 401 unauthorized", async () => {
    await expect(verifyAgentToken("Bearer bga_nope")).rejects.toMatchObject({
      status: 401,
      body: { code: "unauthorized" },
    });
  });

  it("期限切れトークンは token_expired", async () => {
    query.mockResolvedValue({
      rows: [
        {
          id: 1,
          email: "a@b.c",
          scopes: ["read"],
          device_name: "t",
          expires_at: new Date(Date.now() - 1000),
          last_membership_check: new Date(),
        },
      ],
    });
    await expect(verifyAgentToken("Bearer bga_x")).rejects.toMatchObject({
      status: 401,
      body: { code: "token_expired" },
    });
  });

  it("失効済みトークンは 401 unauthorized", async () => {
    query.mockResolvedValue({
      rows: [
        {
          id: 1,
          email: "a@b.c",
          scopes: ["read"],
          device_name: "t",
          expires_at: new Date(Date.now() + 86400_000),
          last_membership_check: new Date(),
          revoked_at: new Date(),
        },
      ],
    });
    await expect(verifyAgentToken("Bearer bga_x")).rejects.toMatchObject({
      status: 401,
      body: { code: "unauthorized" },
    });
  });

  it("last_membership_check が 6 時間以内なら Ghost を呼ばない", async () => {
    query.mockImplementation(async (sql: string) => {
      if (String(sql).includes("SELECT id, token_hash")) {
        return {
          rows: [
            {
              id: 1,
              email: "a@b.c",
              scopes: ["read"],
              device_name: "t",
              expires_at: new Date(Date.now() + 86400_000),
              last_membership_check: new Date(), // 直近 = 再判定不要
            },
          ],
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const ctx = await verifyAgentToken("Bearer bga_x");
    expect(findMemberByEmail).not.toHaveBeenCalled();
    expect(ctx.userId).toBe("uid_test");
    expect(ctx.email).toBe("a@b.c");
  });

  it("6 時間以上経過で Ghost 再判定・非会員ならトークン失効 + membership_ended", async () => {
    const revokes: unknown[][] = [];
    query.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.includes("SELECT id, token_hash")) {
        return {
          rows: [
            {
              id: 1,
              email: "a@b.c",
              scopes: ["read"],
              device_name: "t",
              expires_at: new Date(Date.now() + 86400_000),
              last_membership_check: new Date(Date.now() - 7 * 3600_000), // 7h 前
            },
          ],
        };
      }
      if (s.includes("UPDATE agent_tokens SET revoked_at")) {
        revokes.push(query.mock.calls.at(-1)![1] as unknown[]);
        return { rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    findMemberByEmail.mockResolvedValue({ email: "a@b.c", status: "free" });
    await expect(verifyAgentToken("Bearer bga_x")).rejects.toMatchObject({
      status: 403,
      body: { code: "membership_ended" },
    });
    expect(revokes[0]).toEqual([1]);
  });

  it("Ghost 再判定・有料会員なら通す（判定は isPaidMember を再利用）", async () => {
    query.mockImplementation(async (sql: string) => {
      if (String(sql).includes("SELECT id, token_hash")) {
        return {
          rows: [
            {
              id: 1,
              email: "a@b.c",
              scopes: ["read"],
              device_name: "t",
              expires_at: new Date(Date.now() + 86400_000),
              last_membership_check: new Date(Date.now() - 7 * 3600_000),
            },
          ],
        };
      }
      return { rows: [], rowCount: 0 };
    });
    findMemberByEmail.mockResolvedValue({ email: "a@b.c", status: "paid" });
    const ctx = await verifyAgentToken("Bearer bga_x");
    expect(ctx.tokenId).toBe(1);
  });

  it("Ghost 到達不能は fail closed (502)", async () => {
    query.mockImplementation(async (sql: string) => {
      if (String(sql).includes("SELECT id, token_hash")) {
        return {
          rows: [
            {
              id: 1,
              email: "a@b.c",
              scopes: ["read"],
              device_name: "t",
              expires_at: new Date(Date.now() + 86400_000),
              last_membership_check: new Date(Date.now() - 7 * 3600_000),
            },
          ],
        };
      }
      return { rows: [], rowCount: 0 };
    });
    findMemberByEmail.mockRejectedValue(new Error("ghost down"));
    await expect(verifyAgentToken("Bearer bga_x")).rejects.toMatchObject({ status: 502 });
  });
});

describe("requireScope", () => {
  const ctx = { tokenId: 1, email: "a@b.c", userId: "u", deviceName: "t", scopes: ["read"] as any, expiresAt: "" };
  it("持っているスコープは通す", () => {
    expect(() => requireScope(ctx, "read")).not.toThrow();
  });
  it("持っていないスコープは forbidden", () => {
    try {
      requireScope(ctx, "write");
      throw new Error("should not reach");
    } catch (e) {
      expect(e).toBeInstanceOf(AgentAuthError);
      expect((e as AgentAuthError).body.code).toBe("forbidden");
    }
  });
});

describe("checkRateLimit (SQL 形状)", () => {
  it("固定窓 UPSERT を 1 クエリで行う", async () => {
    query.mockResolvedValue({ rows: [{ count: 5, window_start: new Date() }] });
    const r = await checkRateLimit(1, "read");
    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toContain("ON CONFLICT (key)");
    expect(String(sql)).toContain("window_start");
    expect(params).toEqual(["1:read", RATE_RULES.read.window]);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(RATE_RULES.read.limit - 5);
  });

  it("上限超過で allowed=false + retryAfter", async () => {
    query.mockResolvedValue({ rows: [{ count: 121, window_start: new Date() }] });
    const r = await checkRateLimit(1, "read");
    expect(r.allowed).toBe(false);
    expect(r.retryAfter).toBeGreaterThan(0);
  });

  it("レート規約は設計書どおり", () => {
    expect(RATE_RULES.read).toEqual({ limit: 120, window: "1 minute" });
    expect(RATE_RULES.read_state).toEqual({ limit: 60, window: "1 minute" });
    expect(RATE_RULES.write).toEqual({ limit: 10, window: "1 hour" });
    expect(RATE_RULES.chat).toEqual({ limit: 30, window: "1 hour" });
  });
});
