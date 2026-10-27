/* 🐶 「@ビーグル」の呼びかけ（DB を使わない決まりだけ。リマインドの純粋な関数からも使う）。
 * 「@ビーグルさん」「@ビーグルくん」も呼びかけ（QA 2026-10-27: いちばんありそうな呼び方を取りこぼしていた）。 */
const CALL = /[@＠]ビーグル(?:さん|くん|君|ちゃん|様|さま)?(?![\p{L}\p{N}])/u;

export function asksBeagle(body: string): boolean {
  return CALL.test(body);
}

/** 「@ビーグル」の呼びかけを外す（敬称つきも）。 */
export function stripBeagleCall(body: string, by = ""): string {
  return body.replace(new RegExp(CALL.source, "gu"), by);
}

// ビーグルが最後にその人へ答えた時刻（@ なしの「続き」の下見。DB を見る前のふるい、pm2 は 1 つ）。サーバの答え・端末内 AI の
// 答えの両方で付ける。再起動で消えるが、そのときは名前の呼びかけだけが候補になる。
const g = globalThis as unknown as { __beagleLastAnswered?: Map<string, number> };
const lastAnswered = (g.__beagleLastAnswered ??= new Map<string, number>());

export function noteBeagleAnswered(email: string, at = Date.now()): void {
  lastAnswered.set(email.toLowerCase(), at);
  if (lastAnswered.size > 2000) {
    for (const [k, t] of lastAnswered) if (at - t > 3600_000) lastAnswered.delete(k);
  }
}

export function beagleAnsweredWithin(email: string, ms: number, now = Date.now()): boolean {
  const t = lastAnswered.get(email.toLowerCase());
  return t != null && now - t <= ms;
}
