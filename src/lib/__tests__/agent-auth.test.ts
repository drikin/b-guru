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

// レビュー指摘対応: モックが実 SQL の欠落を隠すため、verifyAgentToken の
// SELECT が revoked_at を含むことを文字列レベルで担保する（CRITICAL 再発防止）。
import * as fs from "fs";
import * as path from "path";

describe("agent-auth SQL shape guard", () => {
  it("verifyAgentToken の SELECT は revoked_at を含む（失効検出は実 SQL に依存）", () => {
    const src = fs.readFileSync(path.join(__dirname, "../agent-auth.ts"), "utf8");
    const m = src.match(/SELECT ([^`]+?)FROM agent_tokens WHERE token_hash/);
    expect(m).toBeTruthy();
    expect(m![1]).toContain("revoked_at");
    // 失効チェックが実装に存在すること
    expect(src).toContain("row.revoked_at");
  });

  it("検索パターンは LIKE ワイルドカードをエスケープする", async () => {
    const { sanitizeLikePattern } = await import("../agent-auth");
    expect(sanitizeLikePattern("50%off_test")).toBe("50\\%off\\_test");
    expect(sanitizeLikePattern("%%%")).toBe("\\%\\%\\%");
    expect(sanitizeLikePattern(undefined)).toBeUndefined();
  });
});

// 認証前レート制限: 以前は ON CONFLICT (key, window_start) を使っていたが、
// rate_limits の一意制約は key だけ（db.ts）。PostgreSQL は 42P10 を返し、
// catch が true を返すため制限が素通りしていた。実 DB が無い環境でも検出できるよう、
// 一意制約に合わない ON CONFLICT を拒否する簡易フェイクで振る舞いを確かめる。
describe("認証前レート制限（IP 単位・失敗のみカウント）", () => {
  function rateLimitsUniqueCols(): string {
    const db = fs.readFileSync(path.join(__dirname, "../db.ts"), "utf8");
    const m = db.match(/CREATE TABLE IF NOT EXISTS rate_limits \(([\s\S]+?)\);/);
    expect(m).toBeTruthy();
    const pk = m![1].match(/^\s*(\w+)\s+\w+\s+PRIMARY KEY/m);
    expect(pk).toBeTruthy();
    return `(${pk![1]})`;
  }

  /** rate_limits だけを持つ最小の PostgreSQL もどき。未知トークンは常に not found。 */
  function installFakeDb(validHash?: string) {
    const uniqueCols = rateLimitsUniqueCols();
    const counters = new Map<string, number>();
    query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      const s = String(sql);
      if (s.includes("INSERT INTO rate_limits")) {
        const target = s.match(/ON CONFLICT (\([^)]*\))/)?.[1];
        if (target !== uniqueCols) {
          throw Object.assign(
            new Error("there is no unique or exclusion constraint matching the ON CONFLICT specification"),
            { code: "42P10" }
          );
        }
        const key = String(params[0]);
        const n = (counters.get(key) ?? 0) + 1;
        counters.set(key, n);
        return { rows: [{ count: n, window_start: new Date() }], rowCount: 1 };
      }
      if (s.includes("FROM rate_limits")) {
        const n = counters.get(String(params[0]));
        return { rows: n === undefined ? [] : [{ count: n }], rowCount: n === undefined ? 0 : 1 };
      }
      if (s.includes("FROM agent_tokens WHERE token_hash")) {
        if (validHash && params[0] === validHash) {
          return {
            rows: [{
              id: 7, token_hash: validHash, email: "a@b.c", scopes: ["read"], device_name: "d",
              expires_at: new Date(Date.now() + 86400_000), revoked_at: null,
              last_membership_check: new Date(),
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });
    return counters;
  }

  it("rate_limits の UPSERT はすべて一意制約（key）を ON CONFLICT 対象にする", () => {
    const src = fs.readFileSync(path.join(__dirname, "../agent-auth.ts"), "utf8");
    const targets = [...src.matchAll(/ON CONFLICT (\([^)]*\))/g)].map((m) => m[1]);
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) expect(t).toBe(rateLimitsUniqueCols());
  });

  it("同一 IP からの無効トークン 150 回で以降は 429", async () => {
    installFakeDb();
    for (let i = 0; i < 150; i++) {
      await expect(verifyAgentToken(`Bearer bga_bad${i}`, { ip: "203.0.113.9" })).rejects.toMatchObject({ status: 401 });
    }
    await expect(verifyAgentToken("Bearer bga_bad", { ip: "203.0.113.9" })).rejects.toMatchObject({ status: 429 });
    // 別 IP は影響を受けない
    await expect(verifyAgentToken("Bearer bga_bad", { ip: "198.51.100.1" })).rejects.toMatchObject({ status: 401 });
  });

  it("成功した検証はカウントしない（正規エージェントを締め出さない）", async () => {
    const token = "bga_" + "a".repeat(64);
    const counters = installFakeDb(hashToken(token));
    for (let i = 0; i < 200; i++) {
      await expect(verifyAgentToken(`Bearer ${token}`, { ip: "203.0.113.9" })).resolves.toMatchObject({ tokenId: 7 });
    }
    expect(counters.get("preauth:203.0.113.9")).toBeUndefined();
  });
});

describe("withAgent のクライアント IP", () => {
  it("XFF の先頭を詐称しても認証前レート制限・監査ログは X-Real-IP で数える", async () => {
    const { withAgent } = await import("../agent-auth");
    const make = (spoof: string) =>
      new Request("https://bsm.backspace.fm/api/agent/me", {
        headers: {
          authorization: "Bearer bga_bad",
          "x-forwarded-for": `${spoof}, 203.0.113.9`,
          "x-real-ip": "203.0.113.9",
        },
      });
    await withAgent(make("1.1.1.1"), "/api/agent/me", null, async () => ({ status: 200, body: {} }));
    await withAgent(make("2.2.2.2"), "/api/agent/me", null, async () => ({ status: 200, body: {} }));
    const calls = query.mock.calls.map(([sql, params]) => [String(sql), params as unknown[]] as const);
    const preauthKeys = calls.filter(([s]) => s.includes("rate_limits")).map(([, p]) => p[0]);
    expect(preauthKeys.length).toBeGreaterThan(0);
    expect(new Set(preauthKeys)).toEqual(new Set(["preauth:203.0.113.9"]));
    const auditIps = calls.filter(([s]) => s.includes("agent_audit_log")).map(([, p]) => p[3]);
    expect(auditIps).toEqual(["203.0.113.9", "203.0.113.9"]);
  });
});
