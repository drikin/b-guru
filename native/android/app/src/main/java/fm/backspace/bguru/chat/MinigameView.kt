package fm.backspace.bguru.chat

import android.annotation.SuppressLint
import android.graphics.Color as AColor
import android.net.Uri
import android.os.Build
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/** 🎮 締め切りダッシュ (docs/minigame-spec.md): the game page in a WebView above the chat. The game
 *  draws everything; the app relays the API (its own token), passes stream events, pauses and resumes. */

/** Back from 🎮 to the text view. */
@Composable
fun MinigameBackHandler(minigame: MinigameStore) {
    BackHandler(enabled = minigame.open) { minigame.open = false }
}

/** One game page. Lives while 🎮 is open; destroyed with it. */
private class GameHost {
    @Volatile var web: WebView? = null
    /** The page loaded is our game (the bridge answers only then). */
    @Volatile var allowed = false
    var ready by mutableStateOf(false)
    var heightCss by mutableIntStateOf(0)
    var onMessage: (MinigameLogic.GameOut) -> Unit = {}

    fun send(msg: JsonObject) {
        val w = web ?: return
        if (!ready) return
        w.evaluateJavascript(MinigameLogic.receiveScript(msg), null)
    }
}

/** `MinigameBridge.postMessage(json)` from the page. Called on a WebView thread. */
private class MinigameBridgeJs(private val host: GameHost) {
    @JavascriptInterface
    fun postMessage(json: String?) {
        if (json == null || !host.allowed) return
        val m = MinigameLogic.parse(json) ?: return
        host.web?.post { if (host.allowed) host.onMessage(m) }
    }
}

/** The game, as tall as it says (`size`), never more than [maxHeight] (passed to it as max_height).
 *  Paused while [active] is false (another page, the app in the background, typing in the chat). */
@SuppressLint("SetJavaScriptEnabled", "JavascriptInterface", "ClickableViewAccessibility")
@Composable
fun MinigamePanel(store: ChatStore, active: Boolean, maxHeight: Dp, modifier: Modifier = Modifier) {
    val mg = store.minigame
    val host = remember { GameHost() }
    val scope = rememberCoroutineScope()
    val dark = isSystemInDarkTheme()
    val theme = if (dark) "dark" else "light"
    val maxPx = maxHeight.value.toInt()
    val themeNow by rememberUpdatedState(theme)
    val maxNow by rememberUpdatedState(maxPx)
    val base = remember { Uri.parse(Net.BASE) }

    // The app in the foreground (resumed): otherwise the game is paused.
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var resumed by remember { mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) }
    DisposableEffect(lifecycle) {
        val obs = LifecycleEventObserver { _, e ->
            when (e) {
                Lifecycle.Event.ON_RESUME -> { resumed = true; host.web?.onResume() }
                Lifecycle.Event.ON_PAUSE -> { resumed = false; host.web?.onPause() }
                else -> Unit
            }
        }
        lifecycle.addObserver(obs)
        onDispose { lifecycle.removeObserver(obs) }
    }
    val running = active && resumed

    host.onMessage = { m ->
        when (m) {
            is MinigameLogic.GameOut.Ready -> {
                host.ready = true
                if (mg.demo) mg.demoEngineVersion(m.engineVersion)
                // First the look (theme, size), then the info once GET me answers.
                host.send(MinigameLogic.state(theme = themeNow, maxHeight = maxNow))
                if (!running) host.send(MinigameLogic.simple("pause"))
                scope.launch { mg.info()?.let { host.send(MinigameLogic.state(info = it, theme = themeNow, maxHeight = maxNow)) } }
            }
            is MinigameLogic.GameOut.Haptic -> host.web?.let { gameHaptic(it, m.kind) }
            is MinigameLogic.GameOut.Size -> host.heightCss = m.height
            is MinigameLogic.GameOut.Error -> android.util.Log.w("BguruMinigame", "game: ${m.message}")
            else -> scope.launch { mg.answer(m)?.let(host::send) }
        }
    }

    // Stream events (today's top 10, my best) go to the game as they come.
    DisposableEffect(mg) {
        mg.eventSink = { host.send(it) }
        onDispose { mg.eventSink = null; host.onMessage = {} }
    }
    LaunchedEffect(theme, maxPx, host.ready) { if (host.ready) host.send(MinigameLogic.state(theme = theme, maxHeight = maxPx)) }
    LaunchedEffect(running, host.ready) { if (host.ready) host.send(MinigameLogic.simple(if (running) "resume" else "pause")) }

    val url = remember(mg.gameUrl) {
        Uri.parse(Net.BASE + mg.gameUrl).buildUpon()
            .appendQueryParameter("theme", theme)
            .appendQueryParameter("max_height", "$maxPx")
            .build().toString()
    }
    val h = host.heightCss
    Surface(modifier, color = MaterialTheme.colorScheme.surfaceContainerLow) {
        AndroidView(
            modifier = Modifier.fillMaxWidth().height((if (h > 0) minOf(h, maxPx) else maxPx).dp),
            factory = { ctx ->
                WebView(ctx).apply {
                    host.web = this
                    setBackgroundColor(AColor.TRANSPARENT)
                    isVerticalScrollBarEnabled = false
                    isHorizontalScrollBarEnabled = false
                    overScrollMode = View.OVER_SCROLL_NEVER
                    settings.javaScriptEnabled = true
                    // The game keeps only its mute switch (localStorage `bguru-minigame-mute`).
                    settings.domStorageEnabled = true
                    settings.allowFileAccess = false
                    settings.allowContentAccess = false
                    settings.javaScriptCanOpenWindowsAutomatically = false
                    settings.setSupportMultipleWindows(false)
                    settings.setSupportZoom(false)
                    settings.builtInZoomControls = false
                    settings.setGeolocationEnabled(false)
                    settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                    settings.cacheMode = WebSettings.LOAD_NO_CACHE
                    // WebAudio starts with the first tap (the autoplay rule); no media elements here.
                    settings.mediaPlaybackRequiresUserGesture = true
                    CookieManager.getInstance().setAcceptThirdPartyCookies(this, false)
                    // Taps and holds are the game's; never the pager's swipe.
                    setOnTouchListener { v, e ->
                        if (e.actionMasked == MotionEvent.ACTION_DOWN) v.parent?.requestDisallowInterceptTouchEvent(true)
                        false
                    }
                    webViewClient = object : WebViewClient() {
                        private fun isGame(u: Uri?) = u != null && u.scheme == "https" && u.host == base.host &&
                            (u.path ?: "").startsWith("/minigame/") && !(u.path ?: "").contains("..")

                        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = !isGame(request.url)

                        override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                            host.allowed = isGame(url?.let(Uri::parse))
                            host.ready = false
                        }

                        // Every file comes through the app (no cookie, no token), only /minigame/.
                        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                            val u = request.url
                            if (!isGame(u) || request.method != "GET") return BoardFiles.forbidden()
                            val rest = (u.path ?: "").removePrefix("/minigame/")
                            if (rest.isEmpty()) return BoardFiles.forbidden()
                            return if (mg.demo && BuildConfig.DEMO) BoardFiles.fromAssets(ctx.assets, "minigame/$rest")
                            else BoardFiles.fromServer(Uri.parse(Net.BASE + u.path).toString(), rest)
                        }
                    }
                    addJavascriptInterface(MinigameBridgeJs(host), "MinigameBridge")
                    loadUrl(url)
                }
            },
            onRelease = { w ->
                host.allowed = false
                host.ready = false
                host.web = null
                w.stopLoading()
                w.removeJavascriptInterface("MinigameBridge")
                w.destroy()
            },
        )
    }
}

private fun gameHaptic(v: View, kind: String) {
    val c = when (kind) {
        "select" -> HapticFeedbackConstants.CLOCK_TICK
        "powerup", "highscore" -> if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY
        "dead" -> if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS
        else -> HapticFeedbackConstants.VIRTUAL_KEY // hit
    }
    v.performHapticFeedback(c)
}
