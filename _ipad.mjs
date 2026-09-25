import { chromium, devices } from "playwright";
const b = await chromium.launch();

// iPad Safari の UA を再現（iPadOS 13+ は Macintosh を名乗る）
const IPAD_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const ctx = await b.newContext({
  viewport: { width: 820, height: 1180 },
  deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IPAD_UA,
});
await ctx.addCookies([{ name: "bsm_session", value: process.env.BSM_SESSION, domain: "bsm.backspace.fm", path: "/" }]);
const p = await ctx.newPage();
await p.goto("https://bsm.backspace.fm", { waitUntil: "networkidle" });
await p.waitForTimeout(3500);

// 1. UA 判定
const ua = await p.evaluate(`(() => ({
  ua: navigator.userAgent,
  isIOS: /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream,
  maxTouchPoints: navigator.maxTouchPoints,
  platform: navigator.platform,
}))()`);
console.log("UA判定:", JSON.stringify(ua, null, 1));

// 2. 実際に引っ張ってみる（合成 Touch イベント）
const pulled = await p.evaluate(`(async () => {
  const fire = (type, y) => {
    const t = new Touch({ identifier: 1, target: document.body, clientX: 200, clientY: y });
    document.body.dispatchEvent(new TouchEvent(type, {
      touches: type === 'touchend' ? [] : [t],
      changedTouches: [t], bubbles: true, cancelable: true,
    }));
  };
  const before = document.querySelectorAll('[data-post-id]').length;
  fire('touchstart', 100);
  for (let y = 110; y <= 260; y += 20) { fire('touchmove', y); await new Promise(r=>setTimeout(r,30)); }
  fire('touchend', 260);
  await new Promise(r=>setTimeout(r,2500));
  return { before, after: document.querySelectorAll('[data-post-id]').length };
})()`);
console.log("引っ張り結果:", JSON.stringify(pulled));
await b.close();
