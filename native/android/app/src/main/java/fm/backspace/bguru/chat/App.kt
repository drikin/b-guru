package fm.backspace.bguru.chat

import android.app.Application
import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

class App : Application() {
    lateinit var session: Session; private set

    override fun onCreate() {
        super.onCreate()
        ImageCache.init(this)
        session = Session(this)
        Push.init(this)
        // No stores here: a process woken by FCM (or a notification action) only needs the
        // token, not the chat, timeline and jukebox. The UI and the jukebox's service call
        // session.restore(). The Keystore decryption starts now, off the main thread.
        session.prefetchToken()
    }

    companion object {
        fun session(context: Context) = (context.applicationContext as App).session
    }
}

/** Signed-in state: a ChatStore while a token exists (Keystore, this device only). */
class Session(private val app: Context) {
    var store by mutableStateOf<ChatStore?>(null); private set
    var timeline by mutableStateOf<TimelineStore?>(null); private set
    /** The jukebox (catalogue + player). Created with the sign-in; the tab shows only when
     *  the server turns it on for this member (capabilities.jukebox). */
    var jukebox by mutableStateOf<JukeboxStore?>(null); private set
    val api: ApiClient? get() = store?.api
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var restored = false
    @Volatile private var tokenTask: java.util.concurrent.FutureTask<String?>? = null

    /** Decrypt the saved token on a background thread (App.onCreate). */
    fun prefetchToken() {
        val t = java.util.concurrent.FutureTask { TokenStore.load(app) }
        tokenTask = t
        Thread(t, "token-load").start()
    }

    /** The saved token (prefetched when possible). Blocks; call it off the main thread
     *  unless the UI needs it right now. */
    fun savedToken(): String? = store?.api?.token ?: (tokenTask?.let { runCatching { it.get() }.getOrNull() } ?: TokenStore.load(app))

    /** Main thread. The signed-in stores, once per process: by the activity and the
     *  jukebox's media service — not by a push waking the process. */
    fun restore() {
        if (restored) return
        restored = true
        val t = savedToken()
        tokenTask = null
        t?.let(::start)
    }

    /** Debug / benchmark builds only (`adb shell am start ... --ez demo true`): sample chat,
     *  no network. `--es demo_images http://10.0.2.2:8099` adds many posts with photos
     *  served from this Mac, for measuring scrolling. The jukebox gets fake episodes whose
     *  audio is one local test file (`--es demo_jukebox http://10.0.2.2:8098` serves
     *  test.mp3 from this Mac) — never the real audio hosts. */
    fun startDemo(images: String? = null, jukeboxBase: String? = null, withRoom: Boolean = true, withShogi: Boolean = true, shogiScenario: String = "play", withMinigame: Boolean = true) {
        if (!BuildConfig.DEMO || store?.demo == true) return
        val base = jukeboxBase ?: "http://10.0.2.2:8098"
        jukebox?.stop()
        store = ChatStore(ApiClient("demo"), app).also { it.loadDemo(scale = images != null, images = images, withRoom = withRoom, withShogi = withShogi, shogiScenario = shogiScenario, withMinigame = withMinigame) }
        timeline = TimelineStore(ApiClient("demo")).also { it.loadDemo(images, jukeboxAudio = JukeboxStore.demoAudioUrl(base), media = base) }
        jukebox = JukeboxStore(app, ApiClient("demo"), demoBase = base)
        // Debug: print this emulator's FCM token so a test push can be sent to it.
        if (Push.configured) com.google.firebase.messaging.FirebaseMessaging.getInstance().token
            .addOnSuccessListener { android.util.Log.d("BguruPush", "fcm token: $it") }
            .addOnFailureListener { android.util.Log.d("BguruPush", "fcm token failed: ${it.message}") }
    }

    fun signIn(token: String) {
        TokenStore.save(app, token)
        restored = true
        tokenTask = null
        start(token)
    }

    fun signOut() {
        val s = store ?: return
        s.stop()
        store = null
        timeline?.stop()
        timeline = null
        jukebox?.stop()
        jukebox = null
        ImageCache.token = null
        tokenTask = null
        TokenStore.delete(app)
        scope.launch {
            Push.unregister(app, s.api)
            s.api.revokeSelf()
        }
    }

    private fun start(token: String) {
        val api = ApiClient(token)
        val s = ChatStore(api, app)
        val t = TimelineStore(api)
        timeline = t
        s.onPostCreated = { t.postCreated() }
        jukebox = JukeboxStore(app, api)
        ImageCache.token = token
        store = s // the stream connects when the chat comes on screen (ChatScreen)
        Push.register(app, s.api)
        // The server revoked the token / membership ended → back to login.
        scope.launch {
            snapshotFlow { s.signedOut }.filter { it }.first()
            if (store === s) signOut()
        }
    }
}
