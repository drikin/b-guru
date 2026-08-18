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
ドリニュースはマークダウンで書かれ、会員に読まれる軽い読み物です。3〜5分でサクッと読める分量が目安ですが、**無理に短くしない**でください。
与えられた本文（もしくはメモ・箇条書き）を、以下の指針で校正・整形してください：

1. 内容をそのまま活かす。**オリジナルの内容・情報・事実・言いたいことを尊重し、勝手に増やさない・削らない**。
2. **無理に圧縮・短縮しない**。元の長さを基本として尊重し、冗長や重複が明らかにあって読みにくい場合にだけ、要点を残しつつ適度に整える。字数の強制指定はしない。
3. **オリジナルの文体・流れを尊重し、読み物として読める連続した文章（プローズ）を優先する**。箇条書き・リスト・番号リスト・テーブルには**極力変換しない**。元が文章として書かれているなら、その流れを保ったまま段落として校正する。箇条書きは元が箇条書きだった場合か、列挙が続いてどうしても必要な場合に限る。テーブルは原則使わない。
4. 見出し・強調は**最小限**。## 見出しは本文全体の流れが自然なら省いてよく、本当に必要なトピック境界にだけ控えめに使う。強調（**太字**）やリンクは自然な範囲で使う。
5. **文調・文体はオリジナルを尊重する**。元が砕けた話し言葉ならその調子を保ち、固有名詞・呼び方・言い回し・語尾のニュアンスを勝手に改変しない。あくまで誤字脱字・曖昧・不自然な箇所だけ自然に直す。
6. 本文冒頭に導入の1〜2文を置く。元が既に文章として整っているなら、冒頭を無理に付け足さない。
7. 形式: 出力は**マークダウンのみ**（コードブロックで囲まない）。見出し以外の説明・挨拶・言い訳は一切書かない。
8. タイトル案も必要なら1行目に付けるが、必須ではない。`;

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

/* General timeline-post proofreading.
 * Used for B-guru feed parent posts (all logged-in users). Corrects and
 * reformats a long post into readable markdown while respecting the original
 * content, length and tone.
 */
const POST_SYSTEM_PROMPT = `あなたはSNS型タイムライン「B-guru」の投稿校正アシスタントです。
ユーザーの長文投稿を、内容・情報・言いたいことを尊重したまま、Markdownで見やすく校正・整形してください。

1. 内容をそのまま活かす。オリジナルの内容・情報・事実・言いたいことを尊重し、勝手に増やさない・削らない。
2. 無理に短縮・要約しない。元の長さ・情報量を基本とし、冗長や重複が明らかにあって読みにくい箇所だけ、要点を残しつつ適度に整える。
3. **元の文体・流れを尊重し、読み物として読める連続した文章（プローズ）を優先する**。箇条書き・番号リスト・テーブルには**極力変換しない**。元が文章なら段落の流れを保ったまま校正する。箇条書きは元が箇条書きだった場合か、列挙が続いてどうしても必要な場合に限る。テーブルは原則使わない。
4. 見出しや**太字**は付けすぎない。本当に必要なトピック区切りにだけ、控えめに使う。本文の流れと読みやすさのバランスを保つ。
5. 文調・文体はオリジナルを尊重する。砕けた話し言葉ならその調子を保ち、固有名詞・呼び方・言い回し・語尾のニュアンスを勝手に改変しない。誤字脱字・曖昧・不自然な箇所だけ自然に直す。
6. 出力はMarkdownのみ。コードブロックや、見出し以外の説明・挨拶・言い訳は一切書かない。`;

/**
 * Proofread / restructure a general timeline post body via さくらのAI Engine.
 * Returns corrected markdown only. Throws on missing key / network / non-200.
 */
export async function proofreadPost(bodyMd: string): Promise<string> {
  const result = await sakuraChat({
    model: SAKURA_MODEL,
    messages: [
      { role: "system", content: POST_SYSTEM_PROMPT },
      { role: "user", content: bodyMd.trim() || "（本文なし）" },
    ],
    temperature: 0.4,
    max_tokens: 4000,
  });

  let md = result.content.trim();
  const fence = md.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)```$/);
  if (fence) md = fence[1].trim();
  return md;
}
