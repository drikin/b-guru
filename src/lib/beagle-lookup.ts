/* 🐶 ビーグルの調べもの（無料・鍵なし、オーナー決定 2026-10-24）: 天気は Open-Meteo、「〇〇って誰／何／とは」は
 * 日本語版 Wikipedia。質問の言葉から先に調べて AI に渡す（AI に道具として渡すと、呼ばずに作り話をした）。
 * 外へ送るのは地名か調べる言葉だけ。アプリ側の native/shared/BeagleTools.swift と同じ決まり。 */

import { stripBeagleCall } from "./beagle-call";

const UA = "B-guru (bsm.backspace.fm)";
const TIMEOUT_MS = 8000;

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const WEATHER_RE = /天気|気温|雨|雪|予報|晴れ|寒い|暑い|傘/;
const PLACE_STOP = ["最新", "現在", "最近", "全国", "各地", "天気予報", "降水確率", "天気", "気温", "予報", "明日", "今日", "明後日", "週末", "今週", "傘"];

/** 天気の質問か。 */
export function isWeatherQuestion(q: string): boolean {
  return WEATHER_RE.test(q);
}

/** 天気の質問の地名: 天気や日付ではない最初の言葉（漢字・カタカナ 2 字以上か、英字 3 字以上）。 */
export function placeIn(q: string): string | null {
  for (const m of q.matchAll(/[\p{sc=Han}\p{sc=Katakana}ー]{2,}|[A-Za-z]{3,}/gu)) {
    let w = m[0];
    for (const s of PLACE_STOP) w = w.split(s).join("");
    if ([...w].length >= 2) return w;
  }
  return null;
}

/** 0 = 今日、1 = 明日、2 = あさって。 */
export function dayIn(q: string): number {
  if (/あさって|明後日/.test(q)) return 2;
  if (/明日|あした/.test(q)) return 1;
  return 0;
}

/** 「〇〇って誰／何／とは」「〇〇は誰」の 〇〇（「赤は何個」は拾わない）。 */
export function subjectIn(q: string): string | null {
  const m = q.match(/^\s*([^、。？?！!]{2,30}?)\s*(?:(?:って|とは)\s*(?:誰|だれ|何|なに|なん|どんな|どういう|どこ)|は\s*(?:誰|だれ)(?:です)?\s*[？?]?\s*$)/u);
  const w = m?.[1]?.trim().replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, "");
  return w && [...w].length >= 2 ? w : null;
}

export function weatherWord(c: number): string {
  if (c === 0) return "晴れ";
  if (c === 1 || c === 2) return "晴れ時々くもり";
  if (c === 3) return "くもり";
  if (c === 45 || c === 48) return "霧";
  if (c >= 51 && c <= 57) return "霧雨";
  if ((c >= 61 && c <= 67) || (c >= 80 && c <= 82)) return "雨";
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return "雪";
  if (c >= 95 && c <= 99) return "雷雨";
  return "不明";
}

export async function lookupWeather(place: string, day: number): Promise<string> {
  let hit: Record<string, unknown> | undefined;
  // 「東京」「大阪」だけだと見つからない（「東京都」「大阪府」は見つかる）。
  for (const name of [place, `${place}市`, `${place}都`, `${place}府`, `${place}県`, `${place}町`]) {
    const g = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=ja`);
    const r = (g?.results as Record<string, unknown>[] | undefined)?.[0];
    if (r) {
      hit = r;
      break;
    }
  }
  if (!hit || typeof hit.latitude !== "number" || typeof hit.longitude !== "number") return `「${place}」という場所が見つからない`;
  const f = await getJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${hit.latitude}&longitude=${hit.longitude}` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FTokyo&forecast_days=3`
  );
  const daily = f?.daily as Record<string, unknown[]> | undefined;
  if (!daily) return "天気を取れなかった";
  const i = Math.max(0, Math.min(2, day));
  const at = (k: string) => (Array.isArray(daily[k]) ? daily[k][i] : undefined);
  const code = at("weather_code");
  const hi = at("temperature_2m_max");
  const lo = at("temperature_2m_min");
  const rain = at("precipitation_probability_max");
  let s = `${String(hit.name ?? place)} ${["今日", "明日", "あさって"][i]}: ${weatherWord(typeof code === "number" ? code : -1)}`;
  if (typeof hi === "number") s += ` 最高 ${Math.round(hi)}℃`;
  if (typeof lo === "number") s += ` 最低 ${Math.round(lo)}℃`;
  if (typeof rain === "number") s += ` 降水確率 ${rain}%`;
  return `${s}（Open-Meteo）`;
}

export async function lookupWikipedia(word: string): Promise<string> {
  const s = await getJson(
    `https://ja.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(word)}&srlimit=1&format=json`
  );
  const title = ((s?.query as Record<string, unknown> | undefined)?.search as { title?: string }[] | undefined)?.[0]?.title;
  if (!title) return `Wikipedia に「${word}」は見つからない`;
  const sum = await getJson(`https://ja.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
  const extract = typeof sum?.extract === "string" ? sum.extract : "";
  return extract ? `${title}（Wikipedia）: ${extract.slice(0, 800)}` : `Wikipedia の「${title}」を読めなかった`;
}

/** 質問に要る調べものをして、その結果（要らなければ null）。 */
export async function lookupFor(question: string): Promise<string | null> {
  const q = stripBeagleCall(question);
  if (WEATHER_RE.test(q)) {
    const place = placeIn(q);
    if (place) return lookupWeather(place, dayIn(q));
  }
  const subject = subjectIn(q);
  if (subject) return lookupWikipedia(subject);
  return null;
}
