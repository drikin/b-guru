import { chromium } from "playwright";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies([{ name: "bsm_session", value: process.env.BSM_SESSION, domain: "bsm.backspace.fm", path: "/" }]);
const p = await ctx.newPage();
await p.goto("https://bsm.backspace.fm", { waitUntil: "networkidle" });
await p.waitForTimeout(3000);
for (const w of [1024, 1200, 1280, 1440, 1920]) {
  await p.setViewportSize({ width: w, height: 900 });
  await p.waitForTimeout(600);
  const m = await p.evaluate(`(() => {
    const nav = document.querySelector('[data-cx="navbar"]');
    const aside = document.querySelector('[data-cx="aside"]');
    const main = document.querySelector('.mantine-AppShell-main');
    const col = main?.querySelector('div[style*="max-width"]');
    const vis = (e) => { if (!e) return 0; const b = e.getBoundingClientRect(); return b.width > 0 && b.left < window.innerWidth ? Math.round(b.width) : 0; };
    const cb = col?.getBoundingClientRect();
    return { vw: window.innerWidth, nav: vis(nav), aside: vis(aside),
      colW: cb ? Math.round(cb.width) : null,
      colL: cb ? Math.round(cb.left) : null, colR: cb ? Math.round(cb.right) : null,
      gapR: cb ? Math.round(window.innerWidth - cb.right) : null };
  })()`);
  console.log(JSON.stringify(m));
}
await b.close();
