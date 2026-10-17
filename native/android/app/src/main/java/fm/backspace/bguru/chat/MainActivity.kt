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
        if (BuildConfig.DEBUG && intent?.getBooleanExtra("demo", false) == true) session.startDemo()
        handle(intent)
        setContent {
            BguruTheme {
                val store = session.store
                val timeline = session.timeline
                if (store != null && timeline != null) {
                    LaunchedEffect(store) { Push.askPermissionIfNeeded(this@MainActivity) }
                    MainScreen(store, timeline, onSignOut = session::signOut)
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

    /** A notification tap: open the chat at that message, or the thread of a reply to your post. */
    private fun handle(intent: Intent?) {
        val id = intent?.getLongExtra(Push.EXTRA_MESSAGE_ID, 0L) ?: 0L
        if (id > 0) App.session(this).store?.reveal(id)
        val post = intent?.getLongExtra(Push.EXTRA_POST_ID, 0L) ?: 0L
        if (post > 0) App.session(this).timeline?.openThread = post
    }
}
