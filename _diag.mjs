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

// ピル要素を特定して、引っ張り中の transform を時系列で観察
const trace = await p.evaluate(`(async () => {
  // ピルを探す: position:fixed で top:0 の div
  const pills = [...document.querySelectorAll('div')].filter(e => {
    const cs = getComputedStyle(e);
    return cs.position === 'fixed' && e.getAttribute('aria-hidden') === 'true';
  });
  const pill = pills[0];
  const out = { pillFound: !!pill, pillStyle: pill ? { t: pill.style.transform, o: pill.style.opacity } : null, trace: [] };

  const fire = (type, y) => {
    const t = new Touch({ identifier: 1, target: document.body, clientX: 200, clientY: y });
    document.body.dispatchEvent(new TouchEvent(type, {
      touches: type === 'touchend' ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true,
    }));
  };
  fire('touchstart', 100);
  await new Promise(r=>setTimeout(r,50));
  for (let y = 130; y <= 300; y += 40) {
    fire('touchmove', y);
    await new Promise(r=>setTimeout(r,60));
    out.trace.push({ y, t: pill?.style.transform, o: pill?.style.opacity, scrollY: window.scrollY });
  }
  fire('touchend', 300);
  await new Promise(r=>setTimeout(r,300));
  out.afterEnd = { t: pill?.style.transform, o: pill?.style.opacity };
  return out;
})()`);
console.log(JSON.stringify(trace, null, 1));
await b.close();
