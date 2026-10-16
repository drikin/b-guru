# B-guru Chat for Android

The chat-only app, the Android twin of `native/ios` (same agent API, same rules).
Kotlin + Jetpack Compose, no Google Play: the signed APK is downloaded by members
from B-guru (left menu on Android → `/api/download/android`).

- Sign in: B-guru in an embedded WebView → 「このアプリを接続」 issues a device
  token (read / read_state / chat) with that session's cookie; the web session is
  wiped right after. The token is kept encrypted with an Android Keystore key and
  excluded from backups.
- Live: `/api/agent/stream` (SSE) while the app is on screen; closed in the background.
- Push: FCM data messages carry ids only; `PushService` fetches the text with the
  device's own token and posts the notification (the iOS NSE's job). Reply / ❤️
  from a notification require unlocking the phone.
- Updates: the app compares its versionCode with `/api/download/android/info` and
  shows a banner; the APK is fetched in the browser (where the member is signed in).

## Build

```bash
cd native/android && ./gradlew :app:assembleDebug
```

Debug builds install as `fm.backspace.bguru.chat.debug` next to the release app.
Demo data without network (debug only):
`adb shell am start -n fm.backspace.bguru.chat.debug/fm.backspace.bguru.chat.MainActivity --ez demo true`

## Release

```bash
native/android/scripts/release.sh <版>
native/android/scripts/publish.sh <版> "<今回の変更点>"
```

- Signing key: `~/.bguru-android/release.jks` + `native/android/keystore.properties`
  (both outside git, made once by `scripts/make-key.sh`). **Every update must be
  signed with this key** — back up both files. Certificate SHA-256:
  `05:8A:CF:49:07:48:DF:FA:40:1A:83:83:DE:54:35:B1:E0:1E:D2:54:C7:F9:5A:AB:AC:78:29:52:B6:7C:35:06`
- `publish.sh` copies the APK to `/home/ubuntu/bsm-downloads` and writes
  `android.json` last (the site and the in-app update check switch only then).

## Push (FCM) setup

App side: `native/android/firebase.properties` (not secret — it ships inside the APK):

```
apiKey=<Firebase の API キー>
appId=<1:…:android:…>
projectId=<プロジェクト ID>
senderId=<プロジェクト番号>
```

Without it the app builds and runs without push.

Server side (secret): a service account key JSON with the Firebase Cloud Messaging
API role, stored at `/home/ubuntu/bsm-secrets/fcm-service-account.json` (mode 600),
and `FCM_SERVICE_ACCOUNT_PATH=` pointing to it in `.env.production`.
`/api/agent/capabilities` reports `push.fcm: true` once it is loaded.
