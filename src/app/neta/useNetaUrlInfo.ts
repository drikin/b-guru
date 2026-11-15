"use client";
/* 📝 URL を入れたら題名と一言を補完する（オリジナルのネタ帳の動きを戻した。ドリキン 2026-11-16）。
 * 入れ終わって 0.5 秒で /api/neta/urlinfo に聞き、空いている欄だけ埋める（手で書いたものは上書きしない）。
 * t.co のような短縮 URL は、転送先の URL に置き換える。 */
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

export type UrlInfoState = { loading: boolean; note: string };

type Setter = Dispatch<SetStateAction<string>>;

export function useNetaUrlInfo(
  url: string,
  setters: { setTitle: Setter; setDescription: Setter; setUrl?: Setter },
  opts: { enabled?: boolean; endpoint?: string } = {}
): UrlInfoState {
  const [state, setState] = useState<UrlInfoState>({ loading: false, note: "" });
  const asked = useRef("");
  const set = useRef(setters);
  useEffect(() => {
    set.current = setters;
  });
  const { enabled = true, endpoint = "/api/neta/urlinfo" } = opts;
  useEffect(() => {
    const u = url.trim();
    if (!enabled) {
      asked.current = ""; // 閉じたら忘れる（同じ URL で開き直しても、また埋める）
      return;
    }
    if (!/^https?:\/\/[^/\s]+\.[^/\s]/i.test(u) || u === asked.current) return;
    let alive = true;
    const t = setTimeout(async () => {
      asked.current = u;
      setState({ loading: true, note: "" });
      try {
        const r = await fetch(`${endpoint}?url=${encodeURIComponent(u)}`, { cache: "no-store" });
        const d = r.ok ? await r.json() : null;
        if (!alive) return;
        if (!d) return setState({ loading: false, note: r.status === 429 ? "少し待ってから試してください" : "" });
        const { setTitle, setDescription, setUrl } = set.current;
        const title = typeof d.title === "string" ? d.title : "";
        const description = typeof d.description === "string" ? d.description : "";
        if (title) setTitle((cur) => (cur.trim() ? cur : title));
        if (description) setDescription((cur) => (cur.trim() ? cur : description));
        if (typeof d.finalUrl === "string" && d.finalUrl && setUrl) {
          asked.current = d.finalUrl;
          setUrl((cur) => (cur.trim() === u ? d.finalUrl : cur));
        }
        setState({ loading: false, note: typeof d.note === "string" ? d.note : "" });
      } catch {
        if (alive) setState({ loading: false, note: "" });
      }
    }, 500);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [url, enabled, endpoint]);
  return state;
}
