import { chromium } from "playwright";
const b = await chromium.launch();
// iPad をホーム画面に追加した状態 = standalone モード
const IPAD_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const ctx = await b.newContext({
  viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  userAgent: IPAD_UA,
});
await ctx.addCookies([{ name: "bsm_session", value: process.env.BSM_SESSION, domain: "bsm.backspace.fm", path: "/" }]);
const p = await ctx.newPage();
await p.goto("https://bsm.backspace.fm", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(3500);

// standalone 判定と、スクロールコンテナの状態
const info = await p.evaluate(`(() => {
  const de = document.documentElement;
  return {
    displayModeStandalone: window.matchMedia('(display-mode: standalone)').matches,
    navigatorStandalone: navigator.standalone,
    maxTouchPoints: navigator.maxTouchPoints,
    // スクロールする要素
    docScrollable: de.scrollHeight > de.clientHeight + 20,
    docScrollHeight: de.scrollHeight, docClientHeight: de.clientHeight,
    bodyOverflow: getComputedStyle(document.body).overflow,
    htmlOverflow: getComputedStyle(de).overflow,
    bodyOverscroll: getComputedStyle(document.body).overscrollBehaviorY,
    htmlOverscroll: getComputedStyle(de).overscrollBehaviorY,
  };
})()`);
console.log("standalone 状態:", JSON.stringify(info, null, 1));

// 引っ張りテスト
const pulled = await p.evaluate(`(async () => {
  const fire = (type, y) => {
    const t = new Touch({ identifier: 1, target: document.body, clientX: 200, clientY: y });
    document.body.dispatchEvent(new TouchEvent(type, {
      touches: type === 'touchend' ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true,
    }));
  };
  const before = document.querySelectorAll('[data-post-id]').length;
  fire('touchstart', 100);
  for (let y = 110; y <= 260; y += 20) { fire('touchmove', y); await new Promise(r=>setTimeout(r,30)); }
  fire('touchend', 260);
  await new Promise(r=>setTimeout(r,2500));
  return { before, after: document.querySelectorAll('[data-post-id]').length };
})()`);
console.log("引っ張り:", JSON.stringify(pulled));
await b.close();
