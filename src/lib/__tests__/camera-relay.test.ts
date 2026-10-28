/**
 * camera-relay: dk5090 への HTTP（接続の使い回し・大きすぎる答え・時間切れ）。ローカルの HTTP サーバーで確かめる。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { relayHttp } from "../camera-relay";

let server: http.Server;
let base = "";
let connections = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.url === "/slow") return setTimeout(() => res.end("late"), 500);
      if (req.url === "/big") return res.end(Buffer.alloc(5000));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ method: req.method, len: Buffer.concat(chunks).length, sig: req.headers["x-pc-sig"] ?? null }));
    });
  });
  server.keepAliveTimeout = 30_000;
  server.on("connection", () => connections++);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe("relayHttp", () => {
  it("体と見出しを送り、続けて送っても接続は 1 本のまま", async () => {
    connections = 0;
    const a = await relayHttp(`${base}/v1/edit`, {
      method: "POST",
      headers: { "X-PC-Sig": "abc" },
      body: Buffer.from("hello"),
      timeoutMs: 2000,
      maxBytes: 1000,
    });
    expect(a.status).toBe(200);
    expect(JSON.parse(a.body.toString())).toEqual({ method: "POST", len: 5, sig: "abc" });
    await new Promise((r) => setTimeout(r, 1500)); // fetch（undici）なら閉じている間
    const b = await relayHttp(`${base}/x`, { method: "GET", timeoutMs: 2000, maxBytes: 1000 });
    expect(JSON.parse(b.body.toString())).toMatchObject({ method: "GET", len: 0 });
    expect(connections).toBe(1);
  });
  it("答えが上限を超えたら捨てる", async () => {
    await expect(relayHttp(`${base}/big`, { method: "GET", timeoutMs: 2000, maxBytes: 1000 })).rejects.toThrow();
  });
  it("時間切れ", async () => {
    await expect(relayHttp(`${base}/slow`, { method: "GET", timeoutMs: 100, maxBytes: 1000 })).rejects.toThrow(/timeout/);
  });
  it("答えの最初で onResponse を呼ぶ", async () => {
    let called = false;
    await relayHttp(`${base}/x`, { method: "GET", timeoutMs: 2000, maxBytes: 1000, onResponse: () => (called = true) });
    expect(called).toBe(true);
  });
});
