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
        session = Session(this)
        Push.init(this)
        session.restore()
    }

    companion object {
        fun session(context: Context) = (context.applicationContext as App).session
    }
}

/** Signed-in state: a ChatStore while a token exists (Keystore, this device only). */
class Session(private val app: Context) {
    var store by mutableStateOf<ChatStore?>(null); private set
    val api: ApiClient? get() = store?.api
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    fun restore() {
        TokenStore.load(app)?.let(::start)
    }

    /** Debug builds only (`adb shell am start ... --ez demo true`): sample chat, no network. */
    fun startDemo() {
        if (!BuildConfig.DEBUG || store?.demo == true) return
        store = ChatStore(ApiClient("demo")).also { it.loadDemo() }
    }

    fun signIn(token: String) {
        TokenStore.save(app, token)
        start(token)
    }

    fun signOut() {
        val s = store ?: return
        s.stop()
        store = null
        TokenStore.delete(app)
        scope.launch {
            Push.unregister(app, s.api)
            s.api.revokeSelf()
        }
    }

    private fun start(token: String) {
        val s = ChatStore(ApiClient(token))
        store = s // the stream connects when the chat comes on screen (ChatScreen)
        Push.register(app, s.api)
        // The server revoked the token / membership ended → back to login.
        scope.launch {
            snapshotFlow { s.signedOut }.filter { it }.first()
            if (store === s) signOut()
        }
    }
}
