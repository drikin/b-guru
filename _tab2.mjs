import { chromium } from "playwright";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1024, height: 768 } });
await ctx.addCookies([{ name: "bsm_session", value: process.env.BSM_SESSION, domain: "bsm.backspace.fm", path: "/" }]);
const p = await ctx.newPage();
await p.goto("https://bsm.backspace.fm", { waitUntil: "networkidle" });
await p.waitForTimeout(3000);

// Mantine の breakpoint 実値
const bp = await p.evaluate(`(() => {
  const s = getComputedStyle(document.documentElement);
  return {
    sm: s.getPropertyValue('--mantine-breakpoint-sm'),
    md: s.getPropertyValue('--mantine-breakpoint-md'),
    lg: s.getPropertyValue('--mantine-breakpoint-lg'),
    xl: s.getPropertyValue('--mantine-breakpoint-xl'),
  };
})()`);
console.log("breakpoints:", JSON.stringify(bp));

// 各幅で navbar/aside の表示状態
for (const w of [768, 900, 1024, 1100, 1200, 1280]) {
  await p.setViewportSize({ width: w, height: 768 });
  await p.waitForTimeout(500);
  const m = await p.evaluate(`(() => {
    const nav = document.querySelector('[data-cx="navbar"]');
    const aside = document.querySelector('[data-cx="aside"]');
    const vis = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return b.width > 0 && b.left < window.innerWidth ? Math.round(b.width) : 0; };
    return { nav: vis(nav), aside: vis(aside), vw: window.innerWidth };
  })()`);
  console.log(`w=${w}:`, JSON.stringify(m));
}
await b.close();
