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
    private const val CH_MENTION = "mention"
    private const val CH_CHAT = "chat"
    private const val CH_REPLY = "reply"
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
        ))
    }

    fun notifyMode(context: Context) = prefs(context).getString("notifyMode", "all") ?: "all"
    fun quietHours(context: Context) = prefs(context).getBoolean("quietHours", true)
    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun setSettings(context: Context, mode: String, quiet: Boolean) {
        prefs(context).edit().putString("notifyMode", mode).putBoolean("quietHours", quiet).apply()
        App.session(context).api?.let { register(context, it) }
    }

    /** After sign-in, on a new FCM token and when settings change. */
    fun register(context: Context, api: ApiClient) {
        if (!configured) return
        val app = context.applicationContext
        FirebaseMessaging.getInstance().token.addOnSuccessListener { t ->
            prefs(app).edit().putString("fcmToken", t).apply()
            scope.launch { runCatching { api.registerPush(t, notifyMode(app), quietHours(app)) } }
        }
    }

    /** Sign-out: stop pushes to this device (the token is revoked right after,
     *  which stops them server-side too). */
    suspend fun unregister(context: Context, api: ApiClient) {
        val t = prefs(context).getString("fcmToken", null) ?: return
        api.unregisterPush(t)
        if (configured) runCatching { FirebaseMessaging.getInstance().deleteToken() }
        prefs(context).edit().remove("fcmToken").apply()
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

    // MARK: showing

    fun show(context: Context, data: Map<String, String>) {
        val kind = data["kind"] ?: return
        val messageId = data["message_id"]?.toLongOrNull()
        val postId = data["post_id"]?.toLongOrNull()
        val session = App.session(context)
        // In the foreground the chat is already on screen.
        if ((kind == "chat_mention" || kind == "chat_new") && session.store?.isVisible == true) return
        val api = session.api ?: TokenStore.load(context)?.let(::ApiClient) ?: return

        var title = if (kind == "reply") "B-guru" else "B-guru チャット"
        var text = when (kind) {
            "chat_mention" -> "あなたへのメンションがあります"
            "chat_new" -> "新着メッセージがあります"
            else -> "あなたの投稿に返信がありました"
        }
        if (messageId != null) {
            runBlocking {
                withTimeoutOrNull(8000) { runCatching { api.chatMessage(messageId) }.getOrNull() }
            }?.let { m ->
                title = m.authorName ?: title
                text = m.body
            }
        }

        val open = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            if (messageId != null) putExtra(EXTRA_MESSAGE_ID, messageId)
        }
        val tap = if (kind == "reply" && postId != null) {
            // A reply to your post: open the thread in the app's timeline.
            val thread = Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
                putExtra(EXTRA_POST_ID, postId)
            }
            PendingIntent.getActivity(context, postId.toInt() + 2_000_000, thread, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        } else {
            PendingIntent.getActivity(context, (messageId ?: 0L).toInt(), open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
        val notifId = when (kind) {
            "chat_new" -> NEW_MESSAGES_ID
            "chat_mention" -> (messageId ?: 0L).toInt() + 100
            else -> (postId ?: 0L).toInt() + 1_000_000
        }
        val b = NotificationCompat.Builder(context, when (kind) { "chat_mention" -> CH_MENTION; "chat_new" -> CH_CHAT; else -> CH_REPLY })
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(0xFF16A34A.toInt())
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(tap)
            .setAutoCancel(true)
            .setGroup("chat")
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            // Lock screen: the generic text only (the message shows once unlocked).
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(
                NotificationCompat.Builder(context, CH_CHAT)
                    .setSmallIcon(R.drawable.ic_notification)
                    .setColor(0xFF16A34A.toInt())
                    .setContentTitle(if (kind == "reply") "B-guru" else "B-guru チャット")
                    .setContentText(if (kind == "chat_mention") "あなたへのメンションがあります" else "新着があります")
                    .build()
            )
        // Reply / ❤️ need "unlock first", which Android enforces only from 12 (API 31).
        // Older phones get no actions at all; the receiver also refuses while locked.
        if (messageId != null && kind != "reply" && Build.VERSION.SDK_INT >= 31) {
            b.addAction(replyAction(context, messageId, notifId))
            if (kind == "chat_mention") b.addAction(heartAction(context, messageId, notifId))
        }
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

class PushService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        App.session(this).api?.let { Push.register(this, it) }
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
        val api = App.session(context).api ?: TokenStore.load(context)?.let(::ApiClient) ?: return
        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
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
