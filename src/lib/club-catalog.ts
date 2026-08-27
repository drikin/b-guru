/* 部活動カタログ — 純データ＋純関数（クライアント/サーバー両対応・副作用なし）。
 *
 * B-guru の部活動一覧と、AI分類出力を検証する parseClubOutput。ここは DB・AI・
 * network に一切依存しない純モジュールなので、フロント(page.tsx)とサーバー
 * (clubs.ts)の両方から安全に import できる。サーバー側の自動分類は clubs.ts が、
 * ここのデータ/検証を使う。
 */

export interface ClubDef {
  key: string;
  name: string; // 日本語名（表示用）
  def: string; // 分類時の簡易定義（曖昧クラス切り分けのため）
}

/** 現行の部活動一覧（drikin 提供 2026-08）。key は英字小文字。 */
export const CLUBS: ClubDef[] = [
  { key: "car", name: "車部", def: "車そのもの・運転・所有・購入・整備の話" },
  { key: "bicycle", name: "自転車部", def: "自転車・ロードバイク・サイクリングの話" },
  { key: "travel", name: "旅行部", def: "旅行・出張・観光・旅程の話" },
  { key: "photo", name: "写真部", def: "撮影・被写体・構図・写真作品そのものの話" },
  { key: "camera", name: "カメラ部", def: "カメラ/レンズの機材・ボディ・スペックの話（写真部とは別）" },
  { key: "offsite", name: "突発オフ会部", def: "オフ会・リアルイベント・対面の集まりの話" },
  { key: "gourmet", name: "美食部", def: "美味しいもの・レストラン・グルメ・食事の話題" },
  { key: "game", name: "ゲーム部", def: "ゲームの話題（プレイ・話題のタイトル）" },
  { key: "xr", name: "XR部", def: "VR/AR/MR/XR 関連の話" },
  { key: "apple", name: "リンゴ部", def: "Apple 製品・サービス（iPhone/Mac/visionOS等）の話" },
  { key: "pc", name: "PC部", def: "PC 全般（自作・スペック・Windows等）の話" },
  { key: "fishing", name: "釣り部", def: "釣り・釣行の話" },
  { key: "muscle", name: "筋トレ部", def: "筋トレ・トレーニング・フィットネスの話" },
  { key: "music", name: "音楽部", def: "楽曲・アーティスト・演奏・音楽鑑賞の話" },
  { key: "drone", name: "ドローン部", def: "ドローンの話" },
  { key: "motorsport", name: "モータースポーツ部", def: "レース・サーキット・モータースポーツ観戦の話（車部とは別）" },
  { key: "galaxyfold", name: "ギャラクシーフォールド部", def: "Samsung Galaxy Z Fold 等のフォルダブル話" },
  { key: "lp", name: "LP部", def: "レコード・アナログ盤・LP の話" },
  { key: "mma", name: "格闘技を見よう部", def: "格闘技・MMA・ボクシング等の観戦・話題" },
  { key: "audio", name: "音響部", def: "オーディオ機器・試聴・セッティング・音質の話（音楽部とは別）" },
  { key: "content", name: "コンテンツ部", def: "動画・配信・コンテンツ制作・メディア全体の話" },
  { key: "printer3d", name: "3Dプリンター部", def: "3D プリントの話" },
  { key: "ai", name: "AI部", def: "AI・LLM・生成AI・AIツールの話" },
  { key: "baseball", name: "野球トーク部", def: "野球の話題（観戦・応援・試合）" },
  { key: "stationery", name: "文房具部", def: "文房具・筆記具の話題" },
  { key: "parenting", name: "子育て部", def: "子育て・育児の話題" },
  { key: "expo", name: "万博部", def: "万博・博覧会の話題" },
  { key: "bug", name: "バグ報告", def: "不具合・バグ・エラー・動作不良・再接続等の問題の報告・相談・再現の話" },
];

export const CLUB_KEYS: ReadonlySet<string> = new Set(CLUBS.map((c) => c.key));

/** key → 日本語名（表示用）。未知キーは null。 */
export function clubLabel(key: string | null | undefined): string | null {
  if (!key) return null;
  const c = CLUBS.find((x) => x.key === key);
  return c ? c.name : null;
}

/** モデル出力を部活キーに正規化・検証する純関数（単体テスト対象）。
 *  有効な key ならそれを返し、ハルシネーション/無効値は null を返す。 */
export function parseClubOutput(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim();
  // 前後の引用符・バッククォート・強調記号を除去
  s = s.replace(/^["'`*]+|["'`*]+$/g, "").trim();
  // 複数行なら1行目だけ採用
  s = s.split(/\r?\n/)[0].trim();
  // 箇条書き記号・空白除去
  s = s.replace(/^[-*•·\s]+/, "").trim();
  s = s.toLowerCase();
  return CLUB_KEYS.has(s) ? s : null;
}
