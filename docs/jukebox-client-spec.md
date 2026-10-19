# ジュークボックス — アプリ向け仕様（v1, 2026-10-19）

backspace.fm の過去回（Art19 の公開 RSS、2014 年の #001 から全回）をアプリで聴く。
設計の経緯: Claude Reports「B-guru ジュークボックス設計」（2026-10-19）。サーバは `src/lib/jukebox.ts`。

## 出すかどうか

`GET /api/agent/capabilities` の `features.jukebox`:

```json
{ "enabled": true, "path": "/api/agent/jukebox" }
```

`enabled` が true のときだけ、一番上のタブを「タイムライン｜チャット｜ジュークボックス」の 3 つにする。
古いサーバ（項目なし）や false のときは今までどおり 2 つ。サーバ側の名簿は `JUKEBOX_ALLOW_EMAILS`。

## データ

`GET /api/agent/jukebox`（スコープ read。名簿外は 404 `code: "jukebox_disabled"`）:

```json
{
  "apiVersion": 1,
  "episodes": [
    {
      "id": "gid://art19-episode-locator/V0/…",      // 回の区別（guid）。進み具合の保存キーもこれ
      "title": "#313:Galaxy ＆ 樋口監督ドヤ vs. GoPro 8ドヤ",
      "published_at": "2019-10-20T09:00:00.000Z",
      "audio_url": "https://verifi.podscribe.com/rss/p/dts.podtrac.com/redirect.mp3/rss.art19.com/episodes/….mp3?…",
      "duration_sec": 9021,                            // null のことがある
      "series": "本編",                                // "本編" | "B-side" | "DANBO-side" | "TechnoEdge-side" | "Z-side" | その他 "*-side"
      "number": 313,                                   // null のことがある。系列ごとに重なる（表示と検索だけに使う）
      "summary": "Pixel 4が発表されたわけだが、…",     // 文字だけ、160 字まで
      "web_url": "https://backspace.fm/episode/313/"   // null のことがある
    }
  ],
  "today": { "id": "gid://…", "years_ago": 7, "post_id": 9601 }   // 「N 年前の今日」。null のことがある
}
```

- 全回（約 1,170 回、gzip 前で数百 KB）を新しい順に一度に返す。検索・年と系列の絞り込み・シャッフルは端末で行う。
- タブを開いたときに 1 回読み、端末に保存して次はすぐ出す（裏で読み直す）。
- `today.post_id` は毎朝 7 時（日本時間）にタイムラインへ出る「N 年前の今日」の投稿。そこを開けばその回の感想スレッドになる（7 時前は null）。

## 再生（いちばん大事な決まり）

- **`audio_url` はそのまま使う。** 転送を 3 回たどって CDN に着く（podscribe → podtrac → art19 → CDN）。ダウンロード数の計測なので、
  - たどった先の署名付き URL を保存・使い回ししない（約 24 時間で切れる。計測も外れる）
  - 再生を押すまで読みに行かない（HEAD での事前確認・先読みをしない）
  - 長く止めていて URL が切れたら、元の `audio_url` で作り直し、保存位置へシークする
- 音声は MP3 128 kbps。Range が効くので、途中からの再生・シークができる。
- **バックグラウンド再生**（必須、ドリキン 2026-10-19）
  - iOS: `AVAudioSession` を `.playback` / `.spokenAudio` に設定する。`UIBackgroundModes: audio` は宣言済み。ロック画面・コントロールセンター・AirPods は `MPNowPlayingInfoCenter` と `MPRemoteCommandCenter` で受ける（再生/一時停止、15 秒戻る、30 秒進む、位置の変更、速度）。
  - Mac: プレイヤーはアプリ全体のストアに持つ。パネルを閉じても鳴り続ける。メディアキーとコントロールセンターは `MPNowPlayingInfoCenter` / `MPRemoteCommandCenter` で受ける。
  - Android: Media3 `ExoPlayer` + `MediaSessionService`（ボイスの `VoiceService` とは別サービス）。通知・ロック画面・Bluetooth のボタンに対応する。`foregroundServiceType="mediaPlayback"`。
- 速度: 1.0 / 1.25 / 1.5 / 1.75 / 2.0（声向けのピッチ補正）。15 秒戻る・30 秒進む。
- スリープタイマー: 15 / 30 / 60 分、この回の終わりまで。
- 続きから: 回（`id`）ごとに位置を端末に保存する（10 秒おきと一時停止のとき）。残りが 30 秒を切ったら「聴いた」にする。端末をまたいだ同期は v2。
- **部室（ボイス）に入ったら自動で一時停止する。** 出たら、ミニプレイヤーに「続きを再生」を出す（自動では再開しない）。
- 再生中にボイスへ入ろうとしたときも同じ扱い（一時停止してから入る）。

## 画面

UI 試作: https://claude.ai/artifact/QPJAuFZ4S6mxHtrfGQj3Wr （見た目と動きはこれに合わせる）

- 上: ターンテーブル。レコードが 33⅓ 回転（1 回転 1.8 秒）で回り、止めると止まる。針は再生で下り、止めると上がる。
  - ラベルの色は年ごと（試作の `HUE` 表）。ラベルに回の番号（`#313` / `ep666`、無ければ「特別回」）と年を出す。
  - 動きを減らす設定（Reduce Motion）では回さない。
- その下: 題名、日付・長さ・系列、説明、進み具合のバー、15 秒戻る・再生/一時停止・30 秒進む・速度。
- 「きょうの 1 枚」: 🎲 シャッフル（全回からランダム）と 📅 N 年前の今ごろ（`today`）。
- 「レコード棚」: 検索（題名と説明）、年の切り替え（すべて・2026…2014）、系列の切り替え（すべて・本編・B-side・DANBO-side・TechnoEdge-side・Z-side・その他）、一覧（小さなレコード、題名 2 行、日付、長さ、系列、聴いた ✓ / 途中のバー）。
- ミニプレイヤー: 画面の下。どのタブでも、再生中か一時停止中の回があるあいだ出す（回る小さなレコード、題名、再生/一時停止）。タップでジュークボックスのタブへ。
- タイムラインの投稿に `audio_url` があり、それがジュークボックスの回なら、「♪ 音声（Web で再生）」の代わりに「▶︎ ジュークボックスで聴く」を出し、押すとその回を再生する。
