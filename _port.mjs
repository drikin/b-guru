import { chromium } from "playwright";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2 });
await ctx.addCookies([{ name: "bsm_session", value: process.env.BSM_SESSION, domain: "bsm.backspace.fm", path: "/" }]);
const p = await ctx.newPage();
await p.goto("https://bsm.backspace.fm", { waitUntil: "networkidle" });
await p.waitForTimeout(3500);
for (const pct of [100, 150]) {
  await p.evaluate(pct===100 ? `document.documentElement.style.fontSize=''` : `document.documentElement.style.fontSize='${pct}%'`);
  await p.waitForTimeout(800);
  const m = await p.evaluate(`(() => {
    const nav = document.querySelector('[data-cx="navbar"]');
    const aside = document.querySelector('[data-cx="aside"]');
    const main = document.querySelector('.mantine-AppShell-main');
    const col = main?.querySelector('div[style*="max-width"]');
    const vis = (e) => { if (!e) return 0; const b = e.getBoundingClientRect(); return b.width > 0 && b.left < window.innerWidth ? Math.round(b.width) : 0; };
    const cb = col?.getBoundingClientRect();
    const cs = getComputedStyle(main);
    return { vw: window.innerWidth, nav: vis(nav), aside: vis(aside),
      mainPadL: cs.paddingLeft, mainPadR: cs.paddingRight,
      colW: cb ? Math.round(cb.width) : null, colL: cb ? Math.round(cb.left) : null,
      colR: cb ? Math.round(cb.right) : null,
      gapR: cb ? Math.round(window.innerWidth - cb.right) : null,
      overflowX: document.documentElement.scrollWidth > window.innerWidth };
  })()`);
  console.log(pct+"%:", JSON.stringify(m));
}
await p.screenshot({ path: "/tmp/portrait_150.png" });
await b.close();
