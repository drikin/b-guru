/**
 * 西田カメラ: dk5090（tailscale serve）への HTTP。fetch ではなく node:https で、接続を使い回す。
 * VPS と dk5090 は往復 124ms あり、つなぎ直すたびに TCP と TLS で約 0.4 秒かかる（2026-10-28 測定）。
 * fetch（undici）は 4 秒で接続を閉じるので、撮ってから送るまでに切れてしまう。
 */
import http from "node:http";
import https from "node:https";

const AGENT_OPTS = { keepAlive: true, keepAliveMsecs: 10_000, maxSockets: 8, maxFreeSockets: 4, timeout: 30_000 };
const agents = { "https:": new https.Agent(AGENT_OPTS), "http:": new http.Agent(AGENT_OPTS) };

export interface RelayResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export interface RelayInit {
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: Buffer;
  timeoutMs: number;
  maxBytes: number;
  /** 答えの最初が届いたとき（加工が終わって受け取り始めた合図）。 */
  onResponse?: () => void;
}

class RetryableReset extends Error {}

function once(url: URL, init: RelayInit): Promise<RelayResponse> {
  const mod = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      reject(e);
    };
    const req = mod.request(
      url,
      {
        method: init.method,
        agent: agents[url.protocol as "https:" | "http:"],
        headers: { ...(init.headers ?? {}), ...(init.body ? { "Content-Length": String(init.body.length) } : {}) },
      },
      (res) => {
        init.onResponse?.();
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          if (settled) return;
          size += c.length;
          if (size > init.maxBytes) {
            fail(new Error("response too large"));
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          if (settled) return;
          settled = true;
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) });
        });
        res.on("error", fail);
        res.on("aborted", () => fail(new Error("response aborted")));
      }
    );
    const timer = setTimeout(() => {
      fail(new Error("timeout"));
      req.destroy();
    }, init.timeoutMs);
    req.on("close", () => clearTimeout(timer));
    req.on("error", (e: NodeJS.ErrnoException) => {
      // 使い回した接続を相手が閉じていた（何も届いていない）ときだけ、つなぎ直してもう一度。Node の推奨どおり。
      if (req.reusedSocket && (e.code === "ECONNRESET" || e.code === "EPIPE")) fail(new RetryableReset(e.message));
      else fail(e);
    });
    req.end(init.body);
  });
}

export async function relayHttp(url: string, init: RelayInit): Promise<RelayResponse> {
  const u = new URL(url);
  try {
    return await once(u, init);
  } catch (e) {
    if (e instanceof RetryableReset) return once(u, init);
    throw e;
  }
}

/** 接続を先に作っておく（アプリがカメラを開いたとき）。失敗しても何もしない。 */
export function warmRelay(baseUrl: string | undefined): void {
  if (!baseUrl) return;
  relayHttp(`${baseUrl.replace(/\/+$/, "")}/healthz`, { method: "GET", timeoutMs: 5_000, maxBytes: 1024 }).catch(() => {});
}
