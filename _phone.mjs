import { chromium } from "playwright";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
await ctx.addCookies([{ name: "bsm_session", value: process.env.BSM_SESSION, domain: "bsm.backspace.fm", path: "/" }]);
const p = await ctx.newPage();
await p.goto("https://bsm.backspace.fm", { waitUntil: "networkidle" });
await p.waitForTimeout(3500);
const m = await p.evaluate(`(() => {
  const nav = document.querySelector('[data-cx="navbar"]');
  const main = document.querySelector('.mantine-AppShell-main');
  const col = main?.querySelector('div[style*="max-width"]');
  const nb = nav?.getBoundingClientRect();
  const cb = col?.getBoundingClientRect();
  const cs = getComputedStyle(main);
  return {
    vw: window.innerWidth,
    navVisible: nb ? (nb.width > 0 && nb.left < window.innerWidth) : false,
    navW: nb ? Math.round(nb.width) : 0, navLeft: nb ? Math.round(nb.left) : null,
    mainPadL: cs.paddingLeft,
    colW: cb ? Math.round(cb.width) : null, colL: cb ? Math.round(cb.left) : null,
    navOpened: document.querySelector('[data-cx="navbar"]')?.getAttribute('data-opened'),
  };
})()`);
console.log(JSON.stringify(m, null, 1));
await p.screenshot({ path: "/tmp/phone.png" });
await b.close();
