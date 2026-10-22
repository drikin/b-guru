/* 段階公開の機能フラグ（SHOGI_ENABLED・MINIGAME_ENABLED など、環境変数 1 つで決める）。
 *   未設定・"0"・"false" = 誰にも出さない
 *   "1"・"*"・"true"     = 全員（＝公開。チャットの 1 行・ビーグルの投稿などの「公開後にだけ出すもの」もこのとき）
 *   メールのカンマ区切り = その人だけ（公開前の試し） */

function raw(envName: string): string {
  return (process.env[envName] ?? "").trim();
}

export function featureEnabledFor(envName: string, email: string | null | undefined): boolean {
  if (!email) return false;
  const v = raw(envName);
  if (!v || v === "0" || v.toLowerCase() === "false") return false;
  if (featurePublic(envName)) return true;
  return v
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .includes(email.trim().toLowerCase());
}

/** 全員に公開しているか（"1"・"*"・"true"）。 */
export function featurePublic(envName: string): boolean {
  const v = raw(envName).toLowerCase();
  return v === "1" || v === "*" || v === "true";
}

/** 誰か 1 人にでも出しているか（未設定・"0"・"false" 以外）。サーバ側で「作るかどうか」を決めるとき
 *  （例: 将棋の実況は、見る人がいなくても作っておけば、途中から開いた人に最新の 1 行を出せる）。 */
export function featureOnForAnyone(envName: string): boolean {
  const v = raw(envName);
  return !!v && v !== "0" && v.toLowerCase() !== "false";
}
