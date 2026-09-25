import { chromium } from "playwright";
const b = await chromium.launch();
const IPAD_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const ctx = await b.newContext({
  viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  userAgent: IPAD_UA,
});
await ctx.addCookies([{ name: "bsm_session", value: process.env.BSM_SESSION, domain: "bsm.backspace.fm", path: "/" }]);
const p = await ctx.newPage();
await p.goto("https://bsm.backspace.fm", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(4000);

const reqs = [];
p.on("request", r => { if (r.url().includes("/api/posts")) reqs.push(r.url()); });

// 十分に大きく引っ張る
const res = await p.evaluate(`(async () => {
  const fire = (type, y) => {
    const t = new Touch({ identifier: 1, target: document.body, clientX: 200, clientY: y });
    document.body.dispatchEvent(new TouchEvent(type, {
      touches: type === 'touchend' ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true,
    }));
  };
  fire('touchstart', 100);
  for (let y = 120; y <= 400; y += 20) { fire('touchmove', y); await new Promise(r=>setTimeout(r,25)); }
  fire('touchend', 400);
  await new Promise(r=>setTimeout(r,3000));
  return true;
})()`);
await p.waitForTimeout(1500);
console.log("フィードリクエスト数:", reqs.length);
console.log("URL:", reqs.slice(0,3));
await b.close();
