/**
 * アプリのログイン画面の WebView か（UA で見分ける）。配布中のアプリはトップ（/）を WebView で開いてログインし、
 * 下の「このアプリを接続」で鍵を受け取る。そこにゲスト画面（📝 ネタ帳）を出すと迷うので、昔のログイン画面を出す。
 *  - Android の WebView: UA に "; wv)"。
 *  - iOS・Mac の WKWebView: AppleWebKit なのに "Safari/" が無い（Safari・Chrome などのブラウザには付く）。
 * アプリの中のブラウザ（X や LINE など）も当てはまることがあるが、そこでは昔のログイン画面になるだけ（会員はそのまま入れる）。
 */
export function isAppLoginWebView(ua: string): boolean {
  if (/; wv\)/.test(ua)) return true;
  return /AppleWebKit\//.test(ua) && /(iPhone|iPad|iPod|Macintosh)/.test(ua) && !/Safari\//.test(ua);
}
