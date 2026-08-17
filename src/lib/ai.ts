/* AI proofreading / drafting helper for Dori News.
 * Calls さくらのAI Engine to restructure, markdown-format and proofread a
 * drinews article body. The result is sanitized markdown ready to drop back
 * into the drinews editor.
 */
import { sakuraChat, SAKURA_MODEL } from "./sakura";

export interface ProofreadResult {
  title: string | null;
  markdown: string;
  raw: string;
}

const SYSTEM_PROMPT = `あなたはドリキンの日刊ニュースレター「ドリニュース」の編集者・校正担当です。
ドリニュースはマークダウンで書かれ、会員に読まれる軽い読み物です。通勤電車で3〜5分でサクッと読める 1,500〜2,000字 前後が目安です。
与えられた本文（もしくはメモ・箇条書き）を、以下の指針で校正・整形してください：

1. 内容をそのまま活かしつつ、読みやすく再構成する。勝手に事実・トピックを追加しない。
2. **長すぎる場合は圧縮して本文全文を 1,500〜2,000字 前後に収める**（冗長を削り、要点を残す）。
3. マークダウンで適切にレイアウトする:
   - トピックごとに ## 見出し
   - 箇条書きは - リスト
   - 強調・リンク・引用を自然に使う
4. 日本語として自然で、曖昧・誤字脱字・不自然な言い回しを直す。
5. 本文冒頭に導入の1〜2文を置く。
6. 形式: 出力は**マークダウンのみ**（コードブロックで囲まない）。見出し以外の説明・挨拶・言い訳は一切書かない。
7. タイトル案も必要なら1行目に付けるが、必須ではない。`;

/**
 * Proofread / restructure a drinews article body via さくらのAI Engine.
 * Strips any accidental wrapping code fences from the model output.
 * Throws on missing API key / network / non-200 so the route can 5xx.
 */
export async function proofreadDrinews(input: { title?: string; bodyMd: string }): Promise<ProofreadResult> {
  const userText = [
    input.title ? `タイトル案: ${input.title}` : "",
    "",
    input.bodyMd.trim() || "（本文なし。ドリニュースの話題・メモを書いてください）",
  ].join("\n");

  const result = await sakuraChat({
    model: SAKURA_MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userText },
    ],
    temperature: 0.4,
    max_tokens: 4000,
  });

  const raw = result.content;

  // Strip accidental ```markdown ... ``` wrapping fences.
  let md = raw.trim();
  const fence = md.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)```$/);
  if (fence) md = fence[1].trim();

  // A leading line that looks like a title proposal ("# 〇〇" or plain 1 line before ##)
  let title: string | null = null;
  const firstLine = md.split("\n")[0].trim();
  if (firstLine.startsWith("# ")) {
    title = firstLine.replace(/^#\s+/, "");
    md = md.split("\n").slice(1).join("\n").trim();
  } else if (md.split("\n")[1]?.startsWith("##")) {
    // single plain line then a heading → treat it as the title
    title = firstLine;
    md = md.split("\n").slice(1).join("\n").trim();
  }

  return { title, markdown: md, raw };
}
