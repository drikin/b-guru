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

// 実際のタッチイベントがどう届くか観察する
const probe = await p.evaluate(`(async () => {
  const log = [];
  const onTS = (e) => log.push({ t: 'start', y: e.touches[0]?.clientY, cancelable: e.cancelable, passive: e.defaultPrevented });
  const onTM = (e) => log.push({ t: 'move', y: e.touches[0]?.clientY, cancelable: e.cancelable });
  const onTE = (e) => log.push({ t: 'end' });
  window.addEventListener('touchstart', onTS, { passive: true });
  window.addEventListener('touchmove', onTM, { passive: false });
  window.addEventListener('touchend', onTE);

  const fire = (type, y) => {
    const t = new Touch({ identifier: 1, target: document.body, clientX: 200, clientY: y });
    document.body.dispatchEvent(new TouchEvent(type, {
      touches: type === 'touchend' ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true,
    }));
  };
  fire('touchstart', 100);
  for (let y = 120; y <= 300; y += 30) { fire('touchmove', y); await new Promise(r=>setTimeout(r,40)); }
  fire('touchend', 300);
  await new Promise(r=>setTimeout(r,500));
  window.removeEventListener('touchstart', onTS);
  window.removeEventListener('touchmove', onTM);
  window.removeEventListener('touchend', onTE);
  return log;
})()`);
console.log("イベント:", JSON.stringify(probe));

// ピル（インジケータ）が動いたか
const pill = await p.evaluate(`(() => {
  const el = document.querySelector('[aria-hidden="true"][style*="position: fixed"]');
  return el ? { transform: el.style.transform, opacity: el.style.opacity } : null;
})()`);
console.log("ピル:", JSON.stringify(pill));
await b.close();
