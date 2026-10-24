package fm.backspace.bguru.chat

import android.Manifest
import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import java.util.UUID

/** FCM on Android. The push carries only ids (privacy: the message text never
 *  goes through Google); this service fetches the text with the device's own
 *  token and posts the notification — the Android twin of the iOS Notification
 *  Service Extension. If the fetch fails, a generic text shows. */
object Push {
    const val EXTRA_MESSAGE_ID = "message_id"
    const val EXTRA_POST_ID = "post_id"
    const val EXTRA_SHOGI_GAME_ID = "shogi_game_id"
    const val EXTRA_DM_PEER_ID = "dm_peer_id"
    const val EXTRA_DM_PEER_NAME = "dm_peer_name"
    private const val CH_DM = "dm"
    private const val CH_MENTION = "mention"
    private const val CH_CHAT = "chat"
    private const val CH_REPLY = "reply"
    private const val CH_TIMELINE = "timeline"
    private const val CH_SHOGI = "shogi"
    /** All "new messages" pushes share one rolling notification. */
    private const val NEW_MESSAGES_ID = 1
    private const val PREFS = "push"
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    val configured get() = BuildConfig.FCM_APIKEY.isNotEmpty() && BuildConfig.FCM_APPID.isNotEmpty()

    fun init(context: Context) {
        createChannels(context)
        if (!configured || FirebaseApp.getApps(context).isNotEmpty()) return
        FirebaseApp.initializeApp(
            context,
            FirebaseOptions.Builder()
                .setApiKey(BuildConfig.FCM_APIKEY)
                .setApplicationId(BuildConfig.FCM_APPID)
                .setProjectId(BuildConfig.FCM_PROJECTID)
                .setGcmSenderId(BuildConfig.FCM_SENDERID)
                .build(),
        )
    }

    private fun createChannels(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannels(listOf(
            NotificationChannel(CH_MENTION, "メンション", NotificationManager.IMPORTANCE_HIGH).apply { description = "あなた宛ての @メンション" },
            NotificationChannel(CH_CHAT, "新着メッセージ", NotificationManager.IMPORTANCE_DEFAULT).apply { description = "チャットの新着（まとめて 1 件）" },
            NotificationChannel(CH_REPLY, "投稿への返信", NotificationManager.IMPORTANCE_DEFAULT),
            NotificationChannel(CH_TIMELINE, "タイムラインの新着", NotificationManager.IMPORTANCE_DEFAULT).apply { description = "タイムラインの新しい投稿（コメントは除く）" },
            NotificationChannel(CH_SHOGI, "将棋", NotificationManager.IMPORTANCE_DEFAULT).apply { description = "対局の申し込みと、あなたの番になったとき" },
            NotificationChannel(CH_DM, "DM", NotificationManager.IMPORTANCE_HIGH).apply { description = "あなた宛ての DM（1 対 1）" },
        ))
    }

    fun notifyMode(context: Context) = prefs(context).getString("notifyMode", "all") ?: "all"
    fun quietHours(context: Context) = prefs(context).getBoolean("quietHours", true)
    /** New timeline posts (off by default; the server keeps its own copy too). */
    fun notifyTimeline(context: Context) = prefs(context).getBoolean("notifyTimeline", false)
    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun setSettings(context: Context, mode: String, quiet: Boolean, timeline: Boolean = notifyTimeline(context)) {
        prefs(context).edit().putString("notifyMode", mode).putBoolean("quietHours", quiet).putBoolean("notifyTimeline", timeline).apply()
        App.session(context).api?.let { register(context, it) }
    }

    /** After sign-in / at launch, on a new FCM token and when settings change. Sent only
     *  when something changed since the last successful registration (the FCM token, the
     *  settings, the agent token) or it is a week old — not on every launch. */
    fun register(context: Context, api: ApiClient) {
        if (!configured) return
        val app = context.applicationContext
        FirebaseMessaging.getInstance().token.addOnSuccessListener { t ->
            scope.launch {
                val p = prefs(app)
                val mode = notifyMode(app); val quiet = quietHours(app); val timeline = notifyTimeline(app)
                val sig = PushContent.registrationSignature(t, mode, quiet, timeline, api.token, shogi = NOTIFY_SHOGI)
                val now = System.currentTimeMillis()
                if (p.getString("registered", null) == sig && now - p.getLong("registeredAt", 0L) in 0 until REREGISTER_MS) return@launch
                p.edit().putString("fcmToken", t).apply()
                runCatching { api.registerPush(t, mode, quiet, timeline, notifyShogi = NOTIFY_SHOGI) }
                    .onSuccess { p.edit().putString("registered", sig).putLong("registeredAt", now).apply() }
            }
        }
    }

    private const val REREGISTER_MS = 7L * 24 * 60 * 60 * 1000
    /** This app shows ☗ 将棋 pushes (the server sends them only to devices that say so). */
    private const val NOTIFY_SHOGI = true


    /** Sign-out: stop pushes to this device (the token is revoked right after,
     *  which stops them server-side too). */
    suspend fun unregister(context: Context, api: ApiClient) {
        val t = prefs(context).getString("fcmToken", null) ?: return
        api.unregisterPush(t)
        if (configured) runCatching { FirebaseMessaging.getInstance().deleteToken() }
        prefs(context).edit().remove("fcmToken").remove("registered").remove("registeredAt").apply()
        NotificationManagerCompat.from(context).cancelAll()
    }

    /** Android 13+: ask once, after sign-in. */
    fun askPermissionIfNeeded(activity: Activity) {
        if (Build.VERSION.SDK_INT < 33 || !configured) return
        if (ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        if (prefs(activity).getBoolean("asked", false)) return
        prefs(activity).edit().putBoolean("asked", true).apply()
        ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
    }

    /** The chat is on screen: the rolling "new messages" notification is stale. */
    fun clearChatNotifications(context: Context) {
        NotificationManagerCompat.from(context).cancel(NEW_MESSAGES_ID)
    }

    /** That person's DM conversation is on screen: their notification is stale. */
    fun clearDMNotification(context: Context, peerId: String) {
        NotificationManagerCompat.from(context).cancel(DMLogic.notificationId(peerId))
    }

    // MARK: showing

    fun show(context: Context, data: Map<String, String>) {
        val kind = data["kind"] ?: return
        if (PushContent.isShogi(kind)) { showShogi(context, kind, data["game_id"]?.toLongOrNull() ?: return); return }
        if (kind == PushContent.DM) { showDM(context, data["dm_id"]?.toLongOrNull(), data["peer_id"]); return }
        val messageId = data["message_id"]?.toLongOrNull()
        val postId = data["post_id"]?.toLongOrNull()
        val session = App.session(context)
        // In the foreground the chat is already on screen.
        if ((kind == "chat_mention" || kind == "chat_new") && session.store?.isVisible == true) return
        // (FCM's worker thread: the token is decrypted here, not on the main thread.)
        val api = session.api ?: session.savedToken()?.let(::ApiClient) ?: return

        var title = PushContent.defaultTitle(kind)
        var text = PushContent.defaultText(kind)
        if (messageId != null) {
            runBlocking {
                withTimeoutOrNull(8000) { runCatching { api.chatMessage(messageId) }.getOrNull() }
            }?.let { m ->
                title = m.authorName ?: title
                text = m.body
            }
        }
        if (kind == PushContent.TIMELINE_NEW && postId != null) {
            // Only ids come through FCM: fetch the post with this device's own token.
            runBlocking {
                withTimeoutOrNull(8000) { runCatching { api.thread(postId).post }.getOrNull() }
            }?.let { p ->
                title = PushContent.timelineTitle(p.authorName)
                text = PushContent.timelineText(p.text)
            }
        }

        val open = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            if (messageId != null) putExtra(EXTRA_MESSAGE_ID, messageId)
        }
        val tap = if (PushContent.opensThread(kind) && postId != null) {
            // A reply to your post / a new post: open the thread in the app's timeline.
            val thread = Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
                putExtra(EXTRA_POST_ID, postId)
            }
            PendingIntent.getActivity(context, postId.toInt() + 2_000_000, thread, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        } else {
            PendingIntent.getActivity(context, (messageId ?: 0L).toInt(), open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
        val notifId = PushContent.notificationId(kind, messageId, postId, NEW_MESSAGES_ID)
        val channel = when (kind) {
            "chat_mention" -> CH_MENTION
            "chat_new" -> CH_CHAT
            PushContent.TIMELINE_NEW -> CH_TIMELINE
            else -> CH_REPLY
        }
        val b = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(0xFF16A34A.toInt())
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(tap)
            .setAutoCancel(true)
            .setGroup(if (kind == PushContent.TIMELINE_NEW) "timeline" else "chat")
            .setCategory(if (kind == PushContent.TIMELINE_NEW) NotificationCompat.CATEGORY_SOCIAL else NotificationCompat.CATEGORY_MESSAGE)
            // Lock screen: the generic text only (the message shows once unlocked).
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(
                NotificationCompat.Builder(context, channel)
                    .setSmallIcon(R.drawable.ic_notification)
                    .setColor(0xFF16A34A.toInt())
                    .setContentTitle(PushContent.defaultTitle(kind))
                    .setContentText(PushContent.publicText(kind))
                    .build()
            )
        // Reply / ❤️ need "unlock first", which Android enforces only from 12 (API 31).
        // Older phones get no actions at all; the receiver also refuses while locked.
        if (messageId != null && (kind == "chat_mention" || kind == "chat_new") && Build.VERSION.SDK_INT >= 31) {
            b.addAction(replyAction(context, messageId, notifId))
            if (kind == "chat_mention") b.addAction(heartAction(context, messageId, notifId))
        }
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED || Build.VERSION.SDK_INT < 33) {
            NotificationManagerCompat.from(context).notify(notifId, b.build())
        }
    }

    /** ☗ 将棋: only the game id comes through FCM; the names are read with this device's token. */
    private fun showShogi(context: Context, kind: String, gameId: Long) {
        if (gameId <= 0) return
        val session = App.session(context)
        // Already looking at that game in the chat.
        val store = session.store
        if (store != null && store.isVisible && store.shogi.open && store.shogi.selectedId == gameId) return
        val api = session.api ?: session.savedToken()?.let(::ApiClient) ?: return
        val base = store?.capabilities?.shogiPath ?: "/api/agent/shogi"
        val game = runBlocking { withTimeoutOrNull(8000) { runCatching { api.shogiGame(gameId, base) }.getOrNull() } }
            ?.takeIf { it.first == 200 }?.second?.game
        val text = PushContent.shogiText(kind, game)
        val open = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(EXTRA_SHOGI_GAME_ID, gameId)
        }
        val notifId = PushContent.notificationId(kind, null, gameId, NEW_MESSAGES_ID)
        val tap = PendingIntent.getActivity(context, notifId, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val b = NotificationCompat.Builder(context, CH_SHOGI)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(0xFF16A34A.toInt())
            .setContentTitle(PushContent.defaultTitle(kind))
            .setContentText(text)
            .setContentIntent(tap)
            .setAutoCancel(true)
            .setGroup("shogi")
            .setCategory(NotificationCompat.CATEGORY_SOCIAL)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(
                NotificationCompat.Builder(context, CH_SHOGI)
                    .setSmallIcon(R.drawable.ic_notification)
                    .setColor(0xFF16A34A.toInt())
                    .setContentTitle(PushContent.defaultTitle(kind))
                    .setContentText(PushContent.publicText(kind))
                    .build()
            )
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED || Build.VERSION.SDK_INT < 33) {
            NotificationManagerCompat.from(context).notify(notifId, b.build())
        }
    }

    /** ✉️ DM: only ids come through FCM; the text and the sender's name are read with this device's
     *  token (GET dm/messages/{id}). One notification per person; a tap opens that conversation. */
    private fun showDM(context: Context, messageId: Long?, peerIdHint: String?) {
        val session = App.session(context)
        val store = session.store
        // Already looking at that conversation.
        if (peerIdHint != null && store?.dm?.visiblePeerId == peerIdHint) return
        val api = session.api ?: session.savedToken()?.let(::ApiClient) ?: return
        val base = store?.capabilities?.dmPath ?: "/api/agent/dm"
        val r = if (messageId == null || messageId <= 0) null
            else runBlocking { withTimeoutOrNull(8000) { runCatching { api.dmMessage(messageId, base) }.getOrNull() } }
        val peerId = r?.message?.peerId?.ifEmpty { null } ?: r?.peer?.userId ?: peerIdHint ?: return
        if (store?.dm?.visiblePeerId == peerId) return
        val (title, text) = PushContent.dmContent(r?.peer?.name, r?.message?.body)
        val open = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(EXTRA_DM_PEER_ID, peerId)
            r?.peer?.name?.let { putExtra(EXTRA_DM_PEER_NAME, it) }
        }
        val notifId = DMLogic.notificationId(peerId)
        val tap = PendingIntent.getActivity(context, notifId, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val b = NotificationCompat.Builder(context, CH_DM)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(0xFF16A34A.toInt())
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(tap)
            .setAutoCancel(true)
            .setGroup("dm")
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            // Lock screen: the generic text only.
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(
                NotificationCompat.Builder(context, CH_DM)
                    .setSmallIcon(R.drawable.ic_notification)
                    .setColor(0xFF16A34A.toInt())
                    .setContentTitle(PushContent.defaultTitle(PushContent.DM))
                    .setContentText(PushContent.publicText(PushContent.DM))
                    .build()
            )
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED || Build.VERSION.SDK_INT < 33) {
            NotificationManagerCompat.from(context).notify(notifId, b.build())
        }
    }

    // Someone holding a locked phone must not be able to post or react as its
    // owner: both actions require unlocking first.
    private fun replyAction(context: Context, messageId: Long, notifId: Int): NotificationCompat.Action {
        val intent = Intent(context, ActionReceiver::class.java).setAction(ActionReceiver.REPLY)
            .putExtra(EXTRA_MESSAGE_ID, messageId).putExtra("notif", notifId)
        val pi = PendingIntent.getBroadcast(context, notifId * 2, intent, PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return NotificationCompat.Action.Builder(0, "返信", pi)
            .addRemoteInput(RemoteInput.Builder(ActionReceiver.KEY_TEXT).setLabel("メッセージ").build())
            .setAllowGeneratedReplies(false)
            .setAuthenticationRequired(true)
            .build()
    }

    private fun heartAction(context: Context, messageId: Long, notifId: Int): NotificationCompat.Action {
        val intent = Intent(context, ActionReceiver::class.java).setAction(ActionReceiver.HEART)
            .putExtra(EXTRA_MESSAGE_ID, messageId).putExtra("notif", notifId)
        val pi = PendingIntent.getBroadcast(context, notifId * 2 + 1, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return NotificationCompat.Action.Builder(0, "❤️", pi).setAuthenticationRequired(true).build()
    }
}

/** The pure parts of a push: texts, ids, where a tap goes (unit-tested). */
object PushContent {
    const val TIMELINE_NEW = "timeline_new"
    const val TIMELINE_TEXT_MAX = 240

    const val SHOGI_OFFER = "shogi_offer"
    const val SHOGI_TURN = "shogi_turn"

    fun isShogi(kind: String) = kind == SHOGI_OFFER || kind == SHOGI_TURN

    /** ✉️ 簡易 DM (`dm_id`, `peer_id` — not message_id: older apps would read a chat message by it). */
    const val DM = "dm"

    /** Title and text of a DM notification: the sender and the text when they could be read,
     *  else 「B-guru DM」「DM が届きました」. */
    fun dmContent(name: String?, body: String?): Pair<String, String> =
        if (body == null) DMLogic.FALLBACK_TITLE to DMLogic.FALLBACK_TEXT
        else DMLogic.notificationTitle(name) to DMLogic.notificationText(body)

    fun defaultTitle(kind: String) = when (kind) {
        "reply" -> "B-guru"
        SHOGI_OFFER, SHOGI_TURN -> "☗ 将棋"
        TIMELINE_NEW -> "B-guru タイムライン"
        DM -> DMLogic.FALLBACK_TITLE
        else -> "B-guru チャット"
    }

    fun defaultText(kind: String) = when (kind) {
        "chat_mention" -> "あなたへのメンションがあります"
        "chat_new" -> "新着メッセージがあります"
        TIMELINE_NEW -> "新しい投稿があります"
        SHOGI_OFFER -> "対局の申し込みが届きました"
        SHOGI_TURN -> "あなたの番です"
        DM -> DMLogic.FALLBACK_TEXT
        else -> "あなたの投稿に返信がありました"
    }

    /** With the game (read with this device's token) the names; without it the generic line. */
    fun shogiText(kind: String, game: ShogiGame?): String {
        if (game == null) return defaultText(kind)
        return when (kind) {
            SHOGI_OFFER -> "${game.creator.name.ifBlank { "だれか" }} さんから対局の申し込み"
            else -> "あなたの番です（${ShogiLogic.vsText(game)}・${game.ply} 手）"
        }
    }

    /** Lock screen: never the content itself. */
    fun publicText(kind: String) = when (kind) {
        "chat_mention" -> "あなたへのメンションがあります"
        TIMELINE_NEW -> "新しい投稿があります"
        SHOGI_OFFER, SHOGI_TURN -> "将棋の通知があります"
        DM -> DMLogic.FALLBACK_TEXT
        else -> "新着があります"
    }

    fun timelineTitle(authorName: String?): String =
        authorName?.trim()?.takeIf { it.isNotEmpty() }?.let { "$it が投稿しました" } ?: defaultTitle(TIMELINE_NEW)

    /** The start of the post (photo-only posts have no text: the generic line). */
    fun timelineText(text: String?): String {
        val t = text?.trim().orEmpty()
        if (t.isEmpty()) return defaultText(TIMELINE_NEW)
        return if (t.length > TIMELINE_TEXT_MAX) t.take(TIMELINE_TEXT_MAX).trimEnd() + "…" else t
    }

    /** What a push registration was made with (a hash: the tokens are not stored again in
     *  clear). Push.register sends again only when this changes (or after a week). */
    fun registrationSignature(fcmToken: String, mode: String, quiet: Boolean, timeline: Boolean, agentToken: String, shogi: Boolean = true): String {
        val md = java.security.MessageDigest.getInstance("SHA-256")
        // notify_shogi joined later: its line changes the hash, so devices register once more.
        md.update("$fcmToken\n$mode\n$quiet\n$timeline\n$agentToken\nshogi=$shogi".toByteArray())
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    /** A tap opens the post's thread in the timeline. */
    fun opensThread(kind: String) = kind == "reply" || kind == TIMELINE_NEW

    /** One notification per post / mention; all "new messages" share one. */
    fun notificationId(kind: String, messageId: Long?, postId: Long?, newMessagesId: Int): Int = when (kind) {
        "chat_new" -> newMessagesId
        "chat_mention" -> (messageId ?: 0L).toInt() + 100
        TIMELINE_NEW -> (postId ?: 0L).toInt() + 3_000_000
        // One per game (offer and turn replace each other, like the server's collapse key shogi-{id}).
        SHOGI_OFFER, SHOGI_TURN -> (postId ?: 0L).toInt() + 4_000_000
        else -> (postId ?: 0L).toInt() + 1_000_000
    }
}

class PushService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        val session = App.session(this)
        (session.api ?: session.savedToken()?.let(::ApiClient))?.let { Push.register(this, it) }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        Push.show(this, message.data)
    }
}

/** Reply / ❤️ from a notification. */
class ActionReceiver : BroadcastReceiver() {
    companion object {
        const val REPLY = "fm.backspace.bguru.chat.REPLY"
        const val HEART = "fm.backspace.bguru.chat.HEART"
        const val KEY_TEXT = "text"
    }

    override fun onReceive(context: Context, intent: Intent) {
        // Never post or react as the owner from a locked phone.
        if (context.getSystemService(android.app.KeyguardManager::class.java).isKeyguardLocked) return
        val messageId = intent.getLongExtra(Push.EXTRA_MESSAGE_ID, 0L)
        val notifId = intent.getIntExtra("notif", 0)
        val session = App.session(context)
        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val api = session.api ?: session.savedToken()?.let(::ApiClient) ?: return@launch
                when (intent.action) {
                    REPLY -> {
                        val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(KEY_TEXT)?.toString()?.trim().orEmpty()
                        if (text.isNotEmpty()) runCatching { api.post(text, UUID.randomUUID().toString()) }
                    }
                    HEART -> if (messageId > 0) runCatching { api.toggleReaction(messageId, "❤️") }
                }
                NotificationManagerCompat.from(context).cancel(notifId)
            } finally {
                pending.finish()
            }
        }
    }
}
