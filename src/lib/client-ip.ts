/**
 * リクエスト元のクライアント IP（レート制限・監査ログ用）。
 *
 * 本番 nginx は X-Real-IP に $remote_addr を入れ、X-Forwarded-For は
 * $proxy_add_x_forwarded_for（クライアントが送った値の末尾に追記）で渡す。
 * そのため XFF の先頭はクライアントが自由に詐称できる。X-Real-IP を優先し、
 * 無い場合は XFF の末尾（直前のプロキシが付けた値）を使う。
 */
export function clientIp(req: { headers: Headers }): string | null {
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const last = req.headers.get("x-forwarded-for")?.split(",").pop()?.trim();
  return last || null;
}
