package fm.backspace.bguru.chat

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/** Keeps a voice-room call alive while the app is in the background or the screen is
 *  off. Holds no audio itself — the LiveKit room lives in VoiceStore (or OffkaiStore: 🍻 オフ会
 *  uses the same service, never at the same time); this only tells Android "a call is going
 *  on" (ongoing notification with 退出).
 *
 *  Starts as "mediaPlayback" (listening; no permission needed) and gains the
 *  "microphone" type on the first unmute, while the app is on screen — without that
 *  type Android silences the mic as soon as the app leaves the screen. Swiping the
 *  app away ends the call, so a live mic never outlives the app. */
class VoiceService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_LEAVE) {
            App.session(this).store?.voice?.leave()
            App.session(this).store?.offkai?.stopListening()
            stopSelf()
            return START_NOT_STICKY
        }
        intent?.getStringExtra(EXTRA_TITLE)?.let { title = it }
        val mic = intent?.getBooleanExtra(EXTRA_MIC, false) == true && App.session(this).store?.voice?.hasMicPermission == true
        if (mic) micType = true
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK or (if (micType) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0)
        } else 0
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(), type)
            foreground = true
        } catch (e: Exception) {
            if (BuildConfig.DEBUG) android.util.Log.d("BguruVoice", "startForeground failed", e)
            // Already running (only adding the mic type failed): keep the call as it is.
            // Never started: end the call — without this service nothing would end it
            // when the app is swiped away, and a live connection must not outlive the app.
            if (!foreground) {
                App.session(this).store?.offkai?.stopListening("オフ会の音声を続けられませんでした。もう一度押してください")
                App.session(this).store?.voice?.leave("ボイスルームを続けられませんでした。もう一度入ってください")
                stopSelf()
            }
        }
        return START_NOT_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        App.session(this).store?.voice?.leave()
        App.session(this).store?.offkai?.stopListening()
        stopSelf()
    }

    override fun onDestroy() {
        micType = false
        foreground = false
        super.onDestroy()
    }

    private var micType = false
    private var foreground = false
    private var title = TITLE_VOICE

    private fun notification() = run {
        val nm = getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "ボイスルーム", NotificationManager.IMPORTANCE_LOW).apply {
                description = "ボイスルームに参加している間だけ表示されます"
                setShowBadge(false)
            })
        }
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val leave = PendingIntent.getService(
            this, 1,
            Intent(this, VoiceService::class.java).setAction(ACTION_LEAVE),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText("タップでチャットに戻ります")
            .setContentIntent(open)
            .addAction(0, "退出", leave)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    companion object {
        private const val CHANNEL = "voice"
        private const val NOTIFICATION_ID = 7001
        private const val ACTION_LEAVE = "fm.backspace.bguru.chat.VOICE_LEAVE"
        private const val EXTRA_MIC = "mic"
        private const val EXTRA_TITLE = "title"
        const val TITLE_VOICE = "ボイスルームに参加中"
        const val TITLE_OFFKAI = "🍻 オフ会を聞いています"
        const val TITLE_OFFKAI_SPEAK = "🍻 オフ会で話しています"

        fun start(context: Context, mic: Boolean, title: String = TITLE_VOICE) {
            runCatching {
                ContextCompat.startForegroundService(context, Intent(context, VoiceService::class.java).putExtra(EXTRA_MIC, mic).putExtra(EXTRA_TITLE, title))
            }.onFailure { if (BuildConfig.DEBUG) android.util.Log.d("BguruVoice", "start service failed", it) }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, VoiceService::class.java))
        }
    }
}
