import { chromium } from "playwright";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1024, height: 900 } });
await ctx.addCookies([{ name: "bsm_session", value: process.env.BSM_SESSION, domain: "bsm.backspace.fm", path: "/" }]);
const p = await ctx.newPage();
await p.goto("https://bsm.backspace.fm", { waitUntil: "networkidle" });
await p.waitForTimeout(3000);
console.log("幅  | nav | aside | 列幅 | 左余白 | 右余白 | 横溢れ");
for (const w of [390, 600, 768, 820, 900, 1024, 1100, 1200, 1280, 1440, 1920]) {
  await p.setViewportSize({ width: w, height: 900 });
  await p.waitForTimeout(500);
  const m = await p.evaluate(`(() => {
    const nav = document.querySelector('[data-cx="navbar"]');
    const aside = document.querySelector('[data-cx="aside"]');
    const main = document.querySelector('.mantine-AppShell-main');
    const col = main?.querySelector('div[style*="max-width"]');
    const vis = (e) => { if (!e) return 0; const b = e.getBoundingClientRect(); return b.width > 0 && b.left < window.innerWidth ? Math.round(b.width) : 0; };
    const cb = col?.getBoundingClientRect();
    const navW = vis(nav);
    return { nav: navW, aside: vis(aside), colW: cb ? Math.round(cb.width) : null,
      lg: cb ? Math.round(cb.left - navW) : null, rg: cb ? Math.round(window.innerWidth - cb.right) : null,
      ox: document.documentElement.scrollWidth > window.innerWidth };
  })()`);
  console.log(`${String(w).padStart(4)} | ${String(m.nav).padStart(3)} | ${String(m.aside).padStart(5)} | ${String(m.colW).padStart(4)} | ${String(m.lg).padStart(6)} | ${String(m.rg).padStart(6)} | ${m.ox}`);
}
await b.close();
