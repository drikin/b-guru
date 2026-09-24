import { chromium } from "playwright";
const BASE = "https://bsm.backspace.fm";
const SESSION = process.env.BSM_SESSION;
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies([{ name: "bsm_session", value: SESSION, domain: "bsm.backspace.fm", path: "/" }]);
const p = await ctx.newPage();
await p.goto(BASE, { waitUntil: "networkidle" });
await p.waitForTimeout(3000);

// 1. Does the real typhoon article URL resolve a preview?
const t1 = await p.evaluate(`(async () => {
  const r = await fetch('/api/posts/duplicates', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ text: '台風26号「スリゲ」発生 沖縄は28日にかけて大しけのおそれ https://www3.nhk.or.jp/news/html/20260924/typhoon26.html' }),
  });
  return await r.json();
})()`);
console.log("fake NHK url:", JSON.stringify(t1).slice(0,200));

// 2. Use the REAL article URL that post 5346 used
const t2 = await p.evaluate(`(async () => {
  const r = await fetch('/api/posts/duplicates', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ text: '台風26号が発生しました https://news.yahoo.co.jp/articles/typhoon26' }),
  });
  return await r.json();
})()`);
console.log("yahoo url:", JSON.stringify(t2).slice(0,200));

// 3. What URL did post 5346 actually use?
const t3 = await p.evaluate(`(async () => {
  const r = await fetch('/api/posts?limit=200');
  const d = await r.json();
  const p5346 = (d.posts||[]).find(x => x.id === 5346);
  return p5346 ? { id: p5346.id, preview: p5346.urlPreview } : 'not found';
})()`);
console.log("post 5346:", JSON.stringify(t3).slice(0,400));
await b.close();
