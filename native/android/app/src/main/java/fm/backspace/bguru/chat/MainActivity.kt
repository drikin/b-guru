package fm.backspace.bguru.chat

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.LaunchedEffect

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val session = App.session(this)
        session.restore()
        if (BuildConfig.DEMO && intent?.getBooleanExtra("demo", false) == true) {
            // `--ez demo_room false` / `--ez demo_shogi false`: the demo without the room / ☗ 将棋.
            session.startDemo(intent.getStringExtra("demo_images"), intent.getStringExtra("demo_jukebox"),
                withRoom = intent.getBooleanExtra("demo_room", true), withShogi = intent.getBooleanExtra("demo_shogi", true),
                // `--es demo_shogi_game play|watch|offer|open|none`: which one game is on (one at a time, site-wide).
                shogiScenario = intent.getStringExtra("demo_shogi_game") ?: "play",
                // `--ez demo_minigame false`: the demo without 🎮.
                withMinigame = intent.getBooleanExtra("demo_minigame", true))
            // Debug: `--es voice_url ws://10.0.2.2:7880 --es voice_token <jwt>` joins a local LiveKit dev server.
            val url = intent.getStringExtra("voice_url")
            val token = intent.getStringExtra("voice_token")
            if (url != null && token != null) session.store?.voice?.devDirect(url, token)
            demoScreen(session)
        }
        handle(intent)
        setContent {
            BguruTheme {
                val store = session.store
                val timeline = session.timeline
                if (store != null && timeline != null) {
                    LaunchedEffect(store) { Push.askPermissionIfNeeded(this@MainActivity) }
                    androidx.compose.foundation.layout.Box {
                        MainScreen(store, timeline, session.jukebox, onSignOut = session::signOut)
                        // ✉️ DM list / conversation over everything (back returns to the chat).
                        DMOverlay(store.dm)
                    }
                } else {
                    LoginScreen(onToken = session::signIn)
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    /** Demo only — open a screen at launch (scripts/orientation-check.sh walks them):
     *  `--es demo_tab timeline|chat|jukebox`, `--ez demo_jukebox_play true`,
     *  `--es demo_open shogi|minigame|offkai|offkai_album|offkai_none|viewer` (viewer: the first photo; needs
     *  `--es demo_images`; offkai_none: no event on, the start form and the archive),
     *  `--es demo_ops …` (the timeline's operations, TimelineStore.demoOps). */
    private fun demoScreen(session: Session) {
        val store = session.store ?: return
        when (intent.getStringExtra("demo_tab")) {
            "timeline" -> store.demoPage = 0
            "jukebox" -> store.demoPage = 2
        }
        if (intent.getBooleanExtra("demo_jukebox_play", false)) session.jukebox?.let { jb -> (jb.current ?: jb.items.firstOrNull())?.let(jb::play) }
        // `--es demo_ops menu|edit|delete|picker|poll_edit|club|pins|…` (TimelineStore.demoOps): the 段階 3
        // operations on the timeline, offline.
        intent.getStringExtra("demo_ops")?.let { what ->
            store.demoPage = 0
            session.timeline?.demoOps(what)
        }
        // `--ez demo_overlay true`: the chat-overlay form (docs/chat-overlay-spec.md) whatever the capabilities say,
        // with 📺 on as if a video were playing (nothing is sent); `--es demo_overlay_show watch,offkai` starts with
        // those small windows, `--es demo_overlay_expand shogi` with that one expanded (keys: room shogi game watch offkai).
        if (intent.getBooleanExtra("demo_overlay", false)) {
            store.demoOverlay = true
            store.watch.loadDemo()
            ActivityId.list(intent.getStringExtra("demo_overlay_show")).forEach { store.overlayShow(it, this) }
            ActivityId.list(intent.getStringExtra("demo_overlay_expand")).lastOrNull()?.let { store.overlayShow(it, this, expand = true) }
        }
        when (intent.getStringExtra("demo_open")) {
            // Through the store, like a push: the others close in the old row (they never open together there);
            // over the chat it is switched on and expanded.
            "shogi" -> store.openPanel(ActivityId.SHOGI)
            "minigame" -> store.openPanel(ActivityId.GAME)
            // 🍻 オフ会: the running one, an ended one's album, or none on.
            "offkai" -> store.openOffkai()
            "offkai_album" -> { store.openOffkai(); store.offkai.archive.firstOrNull()?.let(store.offkai::openAlbum) }
            "offkai_none" -> { store.offkai.demoEndCurrent(); store.openOffkai() }
            "viewer" -> store.demoViewer = true
            // ✉️ the DM list, or the conversation with mazzo (one unread).
            "dm" -> store.dm.openList()
            "dm_chat" -> store.dm.openConversation(DMPeer("mazzo", "mazzo"))
        }
    }

    /** A notification tap: open the chat at that message, or the thread of a reply to your post. */
    private fun handle(intent: Intent?) {
        val id = intent?.getLongExtra(Push.EXTRA_MESSAGE_ID, 0L) ?: 0L
        if (id > 0) App.session(this).store?.reveal(id)
        val post = intent?.getLongExtra(Push.EXTRA_POST_ID, 0L) ?: 0L
        if (post > 0) App.session(this).timeline?.openThread = post
        // ☗ 将棋 (shogi_offer / shogi_turn): the shogi screen at that game.
        val game = intent?.getLongExtra(Push.EXTRA_SHOGI_GAME_ID, 0L) ?: 0L
        if (game > 0) App.session(this).store?.openShogi(game)
        // 🍻 オフ会 (offkai_start): the chat on the 🍻 tab.
        if (intent?.getBooleanExtra(Push.EXTRA_OFFKAI, false) == true) {
            App.session(this).store?.openOffkai()
            intent.removeExtra(Push.EXTRA_OFFKAI)
        }
        // ✉️ DM: that conversation.
        intent?.getStringExtra(Push.EXTRA_DM_PEER_ID)?.takeIf { it.isNotBlank() }?.let { peer ->
            App.session(this).store?.dm?.openConversation(DMPeer(peer, intent.getStringExtra(Push.EXTRA_DM_PEER_NAME)))
            intent.removeExtra(Push.EXTRA_DM_PEER_ID)
        }
        // The jukebox's playback notification.
        if (intent?.getBooleanExtra(JukeboxService.EXTRA_OPEN_JUKEBOX, false) == true) App.session(this).jukebox?.showTab = true
    }
}
