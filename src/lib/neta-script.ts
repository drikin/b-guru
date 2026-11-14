/* 📝 ネタ帳の台本の小物（neta.backspace.fm の shared/script-utils.ts と台本エディタのひな形を移したもの）。
 * 新しい週を作ると、前の週の台本をもとに回の番号と採用ネタを差し替えた台本ができる。 */

/** 前の台本がないときのひな形（ネタ帳の台本エディタのものをそのまま）。 */
export const NETA_DEFAULT_SCRIPT = `# backspace.fm 第XXX回 台本

## ✔︎指差し確認

- [ ] 音声チェック
- [ ] riverside録音スタート
- [ ] YouTubeストリームが正しいことを確認
- [ ] YTライブ開始
- [ ] YTライブ停止
- [ ] 次回カレンダー更新
- [ ] ライブページ更新
- [ ] YTライブ予約
- [ ] 即日配信
- [ ] アフターショー配信

## 今週の台本

＜パン＞

こんにちは、backspace.fm 第XXX回です。
backspace.fmは、AIアーティストの松尾、サンフランシスコ在住のプロ散財家ドリキン、テクニカルジャーナリストの西川善司が時折ゲストを交えながら、毎週、今一番気になることについて話し合うポッドキャスト番組です。

### 今週の一言
**松尾さん**：「＜今週のひとことからの＞ 松尾です。今週もよろしくお願いします。」
**ドリキン**：「＜今週のひとことからの＞ ドリキンです。今週もよろしくお願いします。」
**善司さん**：「＜今週のひとことからの＞ 西川善司です。今週もよろしくお願いします。」

### ゲスト回の時
今週は○○さんをゲストに迎えております。
（ゲストさん紹介一言コメント）

では○○さん簡単に自己紹介をお願いします！
(ここからゲストさんスピーチ開始)

## 番組について
この番組はポッドキャストとYouTubeにて配信しています。
ぜひ番組についての感想やフィードバックをSNSやYouTubeにてコメントください！

この番組はフェンリル株式会社の提供でお届けしております。

フェンリルではこれまで 400 社、600 本以上のアプリを開発しており、
AppStore1位となったものや、ダウンロード数100万本以上のアプリも多数開発しています。
iOS、Android アプリなどモバイルアプリ開発の依頼はフェンリルまでお願いします。

またbackspace.fmをより楽しんでいただくためにBSMという月額有料サービスも行っています。
こちらではアーカイブの即日配信やBSM限定コンテンツなどの特典だけでなく
Discordによる限定コミュニティーも盛り上がっています。
我々の活動サポートにもなりますので、ぜひ登録をご検討ください。

最後に、このポッドキャストの収録はRiverside.fmを利用してリモート収録しています。
Riversideはポッドキャストに特化したリモート収録サービスです。

詳しい情報はポッドキャストやYouTubeの概要欄に記載しています。ぜひチェックしてみてください！

## 告知
話す人と、聴く人。
その間に、さくらインターネットのデジタルインフラサービスがあります。
「『やりたいこと』を『できる』に変える」の企業理念のもと、お客さまのご要望にお応えする多様なサービスを開発し、あらゆる分野に対応するDXソリューションを提案します。

### 5月イベント情報
5月15日（木）さくらのAI Meetup vol.10「MCP」東京支社32F

5月23日（金）さくらのテックナイト in 那覇〜さくらのクラウド編〜inobase沖縄

詳しい情報などがさくらさんの公式Xなどを参考にしてください
https://x.com/sakura_users

---

## 今週のネタ

### 採用ネタ一覧
[採用されたネタのリストがここに表示されます]

---

＜ここからフリートーク＞

---

## エンディング
今週もbackspace.fmをお聞きいただきありがとうございました。

バックスペース主催のSNSコミュニティー、グルドンはさくらインターネットのサポートを受けて運用しています。

さくらインターネットは、1996年創業のインターネット企業です。個人から法人、文教・公共分野まで、さまざまなお客さまのニーズに合わせ、「さくらのレンタルサーバ」「さくらのVPS」「さくらのクラウド」などのクラウドコンピューティングサービスを自社運営の国内のデータセンターを生かし提供しています。「『やりたいこと』を『できる』に変える」の理念のもと、あらゆる分野に対応するDXソリューションを提案します。

今回、番組中に紹介したネタのリンクなどはエピソードの概要欄から参照できます。
ぜひこちらも活用してください！

また来週お楽しみに！
今週も長時間お付き合いいただきありがとうございました。

＜パン＞`;

/** 週の題名から回の番号（"ep668" / "第668回"）。なければ undefined。 */
export function extractEpisodeNumber(title: string): number | undefined {
  const m = title.match(/ep\s*(\d+)|第\s*(\d+)\s*回/i);
  return m ? parseInt(m[1] || m[2], 10) : undefined;
}

/** 台本の中の回の表記を「第N回」にそろえる。番号が分からなければ、ひな形の「第XXX回」だけ週の題名にする。 */
export function replaceEpisodeNumber(content: string, weekTitle: string, episodeNumber: number | undefined): string {
  if (episodeNumber === undefined) return content.replace(/第XXX回/g, weekTitle);
  const label = `第${episodeNumber}回`;
  return content.replace(/第XXX回/g, label).replace(/ep\s*(\d+)/gi, label).replace(/第\s*(\d+)\s*回/g, label);
}

/** 「### 採用ネタ一覧」の中身（次の --- まで）か、ひな形の印を、採用ネタの一覧に差し替える。 */
export function replaceAdoptedTopics(content: string, topicList: string): string {
  const fallback = topicList || "（まだ採用されたネタはありません）";
  const PLACEHOLDER = "[採用されたネタのリストがここに表示されます]";
  if (content.includes(PLACEHOLDER)) return content.replace(PLACEHOLDER, fallback);
  const sectionRe = /(### 採用ネタ一覧)\n([\s\S]*?)(?=\n---\n|$)/;
  if (sectionRe.test(content)) return content.replace(sectionRe, (_m, h: string) => `${h}\n${fallback}`);
  return content;
}

/** 採用ネタの 1 行（ネタ帳と同じ形）。 */
export function adoptedLine(t: { title: string; url: string; submitter: string }): string {
  return `- [${t.title}](${t.url}) by ${t.submitter}`;
}

/** 台本を作る: もとの台本（前の週のもの。なければひな形）の回の番号と採用ネタを差し替える。 */
export function buildScript(base: string | null, weekTitle: string, adopted: { title: string; url: string; submitter: string }[]): string {
  const n = extractEpisodeNumber(weekTitle);
  let s = replaceEpisodeNumber(base || NETA_DEFAULT_SCRIPT, weekTitle, n);
  s = replaceAdoptedTopics(s, adopted.map(adoptedLine).join("\n"));
  return s.replace(/第XXX回/g, n !== undefined ? `第${n}回` : weekTitle).replace(/第回/g, weekTitle);
}
