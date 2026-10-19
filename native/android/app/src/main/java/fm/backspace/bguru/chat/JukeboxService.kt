package fm.backspace.bguru.chat

import android.app.PendingIntent
import android.content.Intent
import androidx.annotation.OptIn
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.CommandButton
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.google.common.collect.ImmutableList

/** Jukebox playback in the background (separate from VoiceService): wraps the process's
 *  ExoPlayer ([JukeboxEngine]) in a MediaSession, so Media3 shows the playback
 *  notification, keeps the service in the foreground (mediaPlayback) while playing, and
 *  takes the lock screen's and Bluetooth / headset buttons. The buttons are 15 秒戻る ·
 *  再生/一時停止 · 30 秒進む, like the screen. */
@OptIn(UnstableApi::class)
class JukeboxService : MediaSessionService() {
    private var session: MediaSession? = null

    override fun onCreate() {
        super.onCreate()
        setMediaNotificationProvider(DefaultMediaNotificationProvider.Builder(this).build().apply {
            setSmallIcon(R.drawable.ic_notification)
        })
        // A tap on the notification opens the app at the jukebox tab.
        val open = PendingIntent.getActivity(
            this, 7,
            Intent(this, MainActivity::class.java).putExtra(EXTRA_OPEN_JUKEBOX, true).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val back = CommandButton.Builder(CommandButton.ICON_SKIP_BACK_15)
            .setPlayerCommand(Player.COMMAND_SEEK_BACK)
            .setDisplayName("15 秒戻る")
            .setSlots(CommandButton.SLOT_BACK)
            .build()
        val forward = CommandButton.Builder(CommandButton.ICON_SKIP_FORWARD_30)
            .setPlayerCommand(Player.COMMAND_SEEK_FORWARD)
            .setDisplayName("30 秒進む")
            .setSlots(CommandButton.SLOT_FORWARD)
            .build()
        session = MediaSession.Builder(this, JukeboxEngine.player(this))
            .setId("jukebox")
            .setSessionActivity(open)
            .setMediaButtonPreferences(ImmutableList.of(back, forward))
            .build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    /** Swiped away from recents: keep playing if it is playing, otherwise go. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        val p = session?.player
        if (p == null || !p.playWhenReady || p.mediaItemCount == 0) stopSelf()
    }

    override fun onDestroy() {
        // The player belongs to the process (the store keeps driving it); only the session goes.
        session?.release()
        session = null
        super.onDestroy()
    }

    companion object {
        const val EXTRA_OPEN_JUKEBOX = "open_jukebox"
    }
}
