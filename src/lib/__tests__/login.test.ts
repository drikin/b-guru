/**
 * login: メールでの本人確認（コード / リンク / 全端末ログアウト / 回数制限）。
 * DB・Ghost・Mailgun はモック。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";

const query = vi.fn();
vi.mock("../db", () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

const findMemberByEmail = vi.fn();
vi.mock("../ghost", () => ({
  findMemberByEmail: (...a: unknown[]) => findMemberByEmail(...(a as [string])),
  isPaidMember: (m: { status?: string } | null) => m?.status === "paid",
}));

const sendEmail = vi.fn();
vi.mock("../mailgun", () => ({ sendEmail: (...a: unknown[]) => sendEmail(...a) }));

import {
  requestLogin,
  verifyLoginCode,
  verifyLoginLink,
  verifyRevokeLink,
  notifyNewLogin,
  hashCode,
  newCode,
  describeDevice,
  LoginError,
} from "../login";

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const sqlOf = (i: number) => String(query.mock.calls[i][0]).replace(/\s+/g, " ");

/** query をSQL の中身で答え分ける。 */
function route(handlers: [RegExp, (params: unknown[]) => unknown][]) {
  query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const s = sql.replace(/\s+/g, " ");
    for (const [re, fn] of handlers) if (re.test(s)) return fn(params);
    return { rows: [], rowCount: 0 };
  });
}

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [], rowCount: 0 });
  findMemberByEmail.mockReset();
  sendEmail.mockReset();
  sendEmail.mockResolvedValue({ message: "ok" });
});

describe("newCode", () => {
  it("6 桁の数字", () => {
    for (let i = 0; i < 50; i++) expect(newCode()).toMatch(/^\d{6}$/);
  });
});

describe("requestLogin", () => {
  it("会員にはコードとリンクを 1 通で送り、DB にはハッシュだけを置く", async () => {
    findMemberByEmail.mockResolvedValue({ status: "paid" });
    route([
      [/^INSERT INTO rate_limits/, () => ({ rows: [{ count: 1 }] })],
      [/^INSERT INTO login_requests/, () => ({ rows: [{ id: 42 }] })],
    ]);
    await requestLogin("a@b.c", "1.2.3.4");
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const mail = sendEmail.mock.calls[0][0];
    const code = /ログインコード: (\d{6})/.exec(mail.subject)![1];
    const link = /\/login\/verify#t=([A-Za-z0-9_-]+)/.exec(mail.text)![1];
    expect(mail.to).toBe("a@b.c");

    const insert = query.mock.calls.find((c) => /INSERT INTO login_requests/.test(c[0]))!;
    expect(insert[1]).toContain(sha(link));
    expect(insert[1]).not.toContain(link);
    const setCode = query.mock.calls.find((c) => /SET code_hash/.test(c[0]))!;
    expect(setCode[1]).toEqual([42, hashCode(42, code)]);
    // 前の未使用コードは無効化される
    expect(query.mock.calls.some((c) => /UPDATE login_requests SET expires_at = now\(\)/.test(c[0]))).toBe(true);
  });

  it("会員でなければメールを送らず、エラーにもしない（同じ返事にするため）", async () => {
    findMemberByEmail.mockResolvedValue(null);
    route([[/^INSERT INTO rate_limits/, () => ({ rows: [{ count: 1 }] })]]);
    await expect(requestLogin("x@y.z", "1.2.3.4")).resolves.toBeUndefined();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("同じアドレスへの送信が上限を超えたら 429", async () => {
    findMemberByEmail.mockResolvedValue({ status: "paid" });
    route([[/^INSERT INTO rate_limits/, (p) => ({ rows: [{ count: String(p[0]).startsWith("login-mail:") ? 6 : 1 }] })]]);
    await expect(requestLogin("a@b.c", "1.2.3.4")).rejects.toMatchObject({ status: 429 });
    expect(findMemberByEmail).not.toHaveBeenCalled();
  });

  it("Ghost に届かなければ 502（fail closed）", async () => {
    findMemberByEmail.mockRejectedValue(new Error("down"));
    route([[/^INSERT INTO rate_limits/, () => ({ rows: [{ count: 1 }] })]]);
    await expect(requestLogin("a@b.c", null)).rejects.toMatchObject({ status: 502 });
  });
});

describe("verifyLoginCode", () => {
  const row = { id: 7, code_hash: hashCode(7, "123456"), attempts: 0 };

  it("正しいコードなら 1 回だけ通る", async () => {
    route([
      [/^SELECT id, code_hash, attempts FROM login_requests/, () => ({ rows: [row] })],
      [/^UPDATE login_requests SET used_at = now\(\)/, () => ({ rows: [{ id: 7, email: "a@b.c" }] })],
    ]);
    await expect(verifyLoginCode("a@b.c", "123456", "1.2.3.4")).resolves.toEqual({ email: "a@b.c", requestId: 7 });
    const used = query.mock.calls.find((c) => /SET used_at = now\(\)/.test(c[0]))!;
    expect(String(used[0])).toContain("used_at IS NULL");
  });

  it("違うコードは attempts を増やして 400", async () => {
    route([[/^SELECT id, code_hash, attempts FROM login_requests/, () => ({ rows: [row] })]]);
    await expect(verifyLoginCode("a@b.c", "000000", "1.2.3.4")).rejects.toMatchObject({ status: 400 });
    expect(query.mock.calls.some((c) => /SET attempts = attempts \+ 1/.test(c[0]))).toBe(true);
    expect(query.mock.calls.some((c) => /SET used_at/.test(c[0]))).toBe(false);
  });

  it("5 回間違えたら正しいコードでも通らない", async () => {
    route([[/^SELECT id, code_hash, attempts FROM login_requests/, () => ({ rows: [{ ...row, attempts: 5 }] })]]);
    await expect(verifyLoginCode("a@b.c", "123456", "1.2.3.4")).rejects.toBeInstanceOf(LoginError);
  });

  it("有効なコードが無ければ 400", async () => {
    await expect(verifyLoginCode("a@b.c", "123456", null)).rejects.toMatchObject({ status: 400 });
  });

  it("6 桁の数字でなければ DB を見ずに 400", async () => {
    await expect(verifyLoginCode("a@b.c", "12ab", null)).rejects.toMatchObject({ status: 400 });
    expect(query.mock.calls.some((c) => /FROM login_requests/.test(c[0]))).toBe(false);
  });

  it("IP の失敗回数が上限なら 429", async () => {
    route([[/^SELECT count FROM rate_limits/, () => ({ rows: [{ count: 30 }] })]]);
    await expect(verifyLoginCode("a@b.c", "123456", "1.2.3.4")).rejects.toMatchObject({ status: 429 });
  });
});

describe("verifyLoginLink", () => {
  it("リンクのハッシュで照合し、使用済みにする", async () => {
    route([[/^UPDATE login_requests SET used_at = now\(\)/, () => ({ rows: [{ id: 3, email: "a@b.c" }] })]]);
    await expect(verifyLoginLink("tok", null)).resolves.toEqual({ email: "a@b.c", requestId: 3 });
    const call = query.mock.calls.find((c) => /SET used_at/.test(c[0]))!;
    expect(call[1]).toEqual([sha("tok")]);
    expect(String(call[0])).toContain("expires_at > now()");
  });

  it("使用済み・期限切れは 400", async () => {
    await expect(verifyLoginLink("tok", null)).rejects.toMatchObject({ status: 400 });
  });
});

describe("notifyNewLogin / verifyRevokeLink", () => {
  it("通知メールの全端末ログアウトリンクは、そのログインの行にハッシュで結び付く", async () => {
    await notifyNewLogin({ email: "a@b.c", requestId: 9 }, "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1");
    const mail = sendEmail.mock.calls[0][0];
    const t = /\/login\/revoke#t=([A-Za-z0-9_-]+)/.exec(mail.text)![1];
    expect(sqlOf(0)).toContain("UPDATE login_requests SET revoke_hash");
    expect(query.mock.calls[0][1]).toEqual([9, sha(t)]);
    expect(mail.text).toContain("iPhone");
  });

  it("メールが送れなくても投げない", async () => {
    sendEmail.mockRejectedValue(new Error("mailgun down"));
    await expect(notifyNewLogin({ email: "a@b.c", requestId: 1 }, null)).resolves.toBeUndefined();
  });

  it("全端末ログアウトリンクは 30 日まで", async () => {
    route([[/^SELECT email FROM login_requests/, () => ({ rows: [{ email: "a@b.c" }] })]]);
    await expect(verifyRevokeLink("r", null)).resolves.toBe("a@b.c");
    const call = query.mock.calls.find((c) => /SELECT email FROM login_requests/.test(c[0]))!;
    expect(call[1]).toEqual([sha("r"), 30]);
  });
});

describe("describeDevice", () => {
  it("OS とブラウザをざっくり", () => {
    expect(describeDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15")).toBe("Mac の Safari");
    expect(describeDevice("Mozilla/5.0 (Linux; Android 15) Chrome/130.0 Mobile Safari/537.36")).toBe("Android の Chrome");
    expect(describeDevice(null)).toBe("不明な端末");
  });
});
