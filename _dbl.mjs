import { chromium } from "playwright";
const b = await chromium.launch();
const IPAD_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const ctx = await b.newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IPAD_UA });
await ctx.addCookies([{ name: "bsm_session", value: process.env.BSM_SESSION, domain: "bsm.backspace.fm", path: "/" }]);
const p = await ctx.newPage();
await p.goto("https://bsm.backspace.fm", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(4000);
// window と document の両方にリスナーがあるか、そして同じイベントが両方を通るか
const r = await p.evaluate(`(async () => {
  const hits = { win: 0, doc: 0 };
  const onW = () => hits.win++;
  const onD = () => hits.doc++;
  window.addEventListener('touchstart', onW);
  document.addEventListener('touchstart', onD);
  const t = new Touch({ identifier: 1, target: document.body, clientX: 200, clientY: 100 });
  document.body.dispatchEvent(new TouchEvent('touchstart', { touches: [t], changedTouches: [t], bubbles: true, cancelable: true }));
  await new Promise(r=>setTimeout(r,100));
  window.removeEventListener('touchstart', onW);
  document.removeEventListener('touchstart', onD);
  return hits;
})()`);
console.log("同じイベントが両方に届くか:", JSON.stringify(r));
await b.close();
