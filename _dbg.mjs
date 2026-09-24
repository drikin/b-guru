import { chromium } from "playwright";
const BASE = "https://bsm.backspace.fm";
const SESSION = process.env.BSM_SESSION;
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies([{ name: "bsm_session", value: SESSION, domain: "bsm.backspace.fm", path: "/" }]);
const p = await ctx.newPage();
await p.goto(BASE, { waitUntil: "networkidle" });
await p.waitForTimeout(4000);
await p.evaluate(`(() => {
  const tab = [...document.querySelectorAll('.mantine-SegmentedControl-label')].find(l => l.textContent.includes('チャット'));
  tab?.click();
})()`);
await p.waitForTimeout(3000);
const r = await p.evaluate(`(() => {
  const a = document.querySelector('[data-cx="chat-actions"]');
  if (!a) return "none";
  const row = a.parentElement;
  const bubble = row?.querySelector('div[style*="border-radius"]');
  const ar = a.getBoundingClientRect();
  const br = bubble ? bubble.getBoundingClientRect() : null;
  return {
    parentTag: row?.tagName, parentClass: row?.className,
    parentStyle: row?.getAttribute('style'),
    bubbleFound: !!bubble,
    bubbleStyle: bubble?.getAttribute('style')?.slice(0,120),
    ar: { l: Math.round(ar.left), r: Math.round(ar.right), t: Math.round(ar.top), b: Math.round(ar.bottom) },
    br: br ? { l: Math.round(br.left), r: Math.round(br.right), t: Math.round(br.top), b: Math.round(br.bottom) } : null,
  };
})()`);
console.log(JSON.stringify(r, null, 1));
await b.close();
