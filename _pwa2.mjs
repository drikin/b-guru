import { chromium } from "playwright";
const b = await chromium.launch();
const IPAD_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const ctx = await b.newContext({
  viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  userAgent: IPAD_UA,
});
// standalone を強制（CDP で display-mode を上書き）
const cdp = await ctx.newCDPSession(await ctx.newPage());
await cdp.send("Emulation.setEmulatedMedia", {
  features: [{ name: "display-mode", value: "standalone" }],
});
await ctx.addCookies([{ name: "bsm_session", value: process.env.BSM_SESSION, domain: "bsm.backspace.fm", path: "/" }]);
const p = await ctx.pages()[0];
await p.goto("https://bsm.backspace.fm", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(4000);

const info = await p.evaluate(`(() => ({
  standalone: window.matchMedia('(display-mode: standalone)').matches,
  navStandalone: navigator.standalone,
  maxTouchPoints: navigator.maxTouchPoints,
  isIOS: (/iPad|iPhone|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 0)) && !window.MSStream,
}))()`);
console.log("standalone:", JSON.stringify(info));

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
