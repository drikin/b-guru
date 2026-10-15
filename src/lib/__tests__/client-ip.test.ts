/**
 * clientIp: XFF の先頭はクライアントが詐称できる（nginx は追記するだけ）ので、
 * X-Real-IP（nginx が $remote_addr を入れる）を優先する。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { clientIp } from "../client-ip";

const req = (h: Record<string, string>) => ({ headers: new Headers(h) });

describe("clientIp", () => {
  it("X-Real-IP を XFF より優先する（先頭の詐称を無視）", () => {
    expect(clientIp(req({ "x-forwarded-for": "1.2.3.4, 203.0.113.9", "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("X-Real-IP が無ければ XFF の末尾（直前のプロキシが付けた値）", () => {
    expect(clientIp(req({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("どちらも無い・空なら null", () => {
    expect(clientIp(req({}))).toBeNull();
    expect(clientIp(req({ "x-real-ip": " ", "x-forwarded-for": "" }))).toBeNull();
  });

  it("ルートは XFF の先頭を直接読まない（clientIp に一本化）", () => {
    const root = path.join(__dirname, "../..");
    for (const f of ["lib/agent-auth.ts", "app/mcp/route.ts", "app/api/bsm/member-check/route.ts"]) {
      const src = fs.readFileSync(path.join(root, f), "utf8");
      expect(src, f).not.toMatch(/x-forwarded-for/i);
      expect(src, f).toContain("clientIp(");
    }
  });
});
