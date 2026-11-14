package fm.backspace.bguru.chat

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner

/**
 * 📝 ネタ帳タブ（DM とプレイヤーの間 — オーナー「アプリはそもそも会員限定なので DM とプレイヤーの間のタブにネタ帳を実装する」
 * 2026-11-14）. The server's mobile page /neta/app in a WebView. The tab shows only when capabilities
 * `features.neta.tab` is there (app-issued tokens only). Entering: GET <tab> with the app's token as
 * `Authorization: Bearer` → the server sets the httpOnly cookie `neta_session` (12 h) and 303s to /neta/app.
 * The page navigates to `bguru-neta://reenter` when that login ran out: we enter again.
 * The WebView belongs to [NetaTabStore] (lives with the sign-in), so switching tabs never reloads it.
 */
object NetaTabLogic {
    /** Back after this long in the background: enter again (fresh login, fresh page). */
    const val STALE_MS = 6L * 60 * 60 * 1000

    enum class Route { REENTER, INSIDE, EXTERNAL, BLOCK }

    /** Where a main-frame navigation to [url] goes. [ourHost]: bsm.backspace.fm. */
    fun route(url: String?, ourHost: String?): Route {
        val u = url?.let { runCatching { java.net.URI(it) }.getOrNull() } ?: return Route.BLOCK
        val scheme = u.scheme?.lowercase()
        return when {
            scheme == "bguru-neta" -> if (u.host == "reenter" || u.schemeSpecificPart.trimStart('/').startsWith("reenter")) Route.REENTER else Route.BLOCK
            scheme == "https" && ourHost != null && u.host.equals(ourHost, ignoreCase = true) -> Route.INSIDE
            scheme == "https" || scheme == "http" || scheme == "mailto" -> Route.EXTERNAL
            else -> Route.BLOCK // intent:, javascript:, file:, …
        }
    }

    /** The app came back to the front at [now] after going to the background at [backgroundSince] (0: it never
     *  went): enter again when the 📝 tab is next on screen. */
    fun staleAfterBackground(backgroundSince: Long, now: Long): Boolean =
        backgroundSince > 0 && now - backgroundSince >= STALE_MS
}

/** The 📝 tab's WebView and its state. Lives as long as the sign-in (ChatStore); [destroy] on sign-out. */
class NetaTabStore(private val token: String) {
    var web by mutableStateOf<WebView?>(null); private set
    var loading by mutableStateOf(false); private set
    var failed by mutableStateOf(false); private set
    var canGoBack by mutableStateOf(false); private set
    private var enterPath: String? = null
    private var entered = false
    private var clearHistoryWhenLoaded = false
    /** When the app went to the background (0: in front). */
    private var backgroundSince = 0L
    /** Back after a long time away: enter again when the tab is next on screen. */
    private var stale = false
    private val base = Uri.parse(Net.BASE)

    /** The tab came on screen (or the app came back with it on screen). Main thread. */
    fun show(context: Context, path: String) {
        if (web == null) web = makeWebView(context.applicationContext)
        if (path != enterPath || !entered || stale) {
            enterPath = path
            stale = false
            enter()
        }
    }

    fun movedToBackground() { if (backgroundSince == 0L) backgroundSince = System.currentTimeMillis() }

    fun movedToForeground(visible: Boolean, context: Context) {
        if (NetaTabLogic.staleAfterBackground(backgroundSince, System.currentTimeMillis())) stale = true
        backgroundSince = 0L
        val path = enterPath
        if (visible && path != null) show(context, path)
    }

    /** GET the entrance with the token: the server logs the page in (cookie) and redirects to /neta/app. */
    fun enter() {
        val w = web ?: return
        val path = enterPath ?: return
        entered = true
        failed = false
        clearHistoryWhenLoaded = true
        w.loadUrl(Net.BASE + path, mapOf("Authorization" to "Bearer $token"))
    }

    /** ↻: the page again (the cookie decides; if it ran out the page asks for reenter). */
    fun reload() {
        val w = web ?: return
        // Not w.reload(): it could resend the entrance's headers. The token goes only with the entrance
        // (enter: first load and bguru-neta://reenter), never with any other load.
        val now = w.url
        if (failed || now == null || NetaTabLogic.route(now, base.host) != NetaTabLogic.Route.INSIDE || now.contains("/enter")) enter()
        else { failed = false; w.loadUrl(now) }
    }

    fun goBack() { web?.takeIf { it.canGoBack() }?.goBack() }

    fun destroy() {
        val w = web ?: return
        web = null
        Handler(Looper.getMainLooper()).post {
            (w.parent as? ViewGroup)?.removeView(w)
            w.stopLoading()
            w.destroy()
        }
    }

    private fun openOutside(ctx: Context, url: Uri) {
        runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }

    /** true: handled here (not loaded in the WebView). */
    private fun handle(view: WebView, url: Uri): Boolean = when (NetaTabLogic.route(url.toString(), base.host)) {
        NetaTabLogic.Route.REENTER -> { view.post { enter() }; true }
        NetaTabLogic.Route.INSIDE -> false
        NetaTabLogic.Route.EXTERNAL -> { openOutside(view.context, url); true }
        NetaTabLogic.Route.BLOCK -> true
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun makeWebView(ctx: Context): WebView = WebView(ctx).apply {
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.setGeolocationEnabled(false)
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.javaScriptCanOpenWindowsAutomatically = false
        // target=_blank: a new window is asked for (onCreateWindow below) and goes to the browser.
        settings.setSupportMultipleWindows(true)
        settings.mediaPlaybackRequiresUserGesture = true
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(this, false)
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (!request.isForMainFrame) return false
                return handle(view, request.url)
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                loading = true
            }

            override fun onPageFinished(view: WebView, url: String?) {
                loading = false
                // A fresh entrance: no way back into the previous login's pages.
                if (clearHistoryWhenLoaded && url != null && !url.contains("/enter")) { clearHistoryWhenLoaded = false; view.clearHistory() }
                canGoBack = view.canGoBack()
            }

            override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
                canGoBack = view.canGoBack()
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) { failed = true; loading = false }
            }
        }
        webChromeClient = object : WebChromeClient() {
            // A link with target=_blank (only on a tap): find its URL with a throwaway WebView, open it outside.
            override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
                if (!isUserGesture) return false
                val probe = WebView(view.context)
                probe.webViewClient = object : WebViewClient() {
                    private var done = false
                    private fun take(w: WebView, u: Uri?): Boolean {
                        if (!done && u != null) {
                            done = true
                            val s = u.scheme?.lowercase()
                            if (s == "https" || s == "http" || s == "mailto") openOutside(view.context, u)
                        }
                        w.post { w.stopLoading(); w.destroy() }
                        return true
                    }
                    override fun shouldOverrideUrlLoading(w: WebView, request: WebResourceRequest): Boolean = take(w, request.url)
                    override fun onPageStarted(w: WebView, url: String?, favicon: android.graphics.Bitmap?) { take(w, url?.let(Uri::parse)) }
                }
                val transport = resultMsg.obj as? WebView.WebViewTransport ?: return false
                transport.webView = probe
                resultMsg.sendToTarget()
                return true
            }
            // No mic / camera / location: onPermissionRequest / onGeolocationPermissionsShowPrompt keep their deny defaults.
        }
    }

    companion object {
        /** Sign-out: the neta_session cookie (and every other WebView cookie) goes. */
        fun clearCookies() {
            runCatching {
                CookieManager.getInstance().removeAllCookies(null)
                CookieManager.getInstance().flush()
            }
        }
    }
}

/** The 📝 page: the tab switch in the bar (like the other pages), ↻, and the store's WebView. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NetaTabScreen(store: NetaTabStore, enterPath: String, tabSwitch: (@Composable () -> Unit)?, visible: Boolean) {
    val ctx = LocalContext.current
    val visibleNow by rememberUpdatedState(visible)
    LaunchedEffect(store, visible, enterPath) { if (visible) store.show(ctx, enterPath) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, store) {
        val obs = LifecycleEventObserver { _, e ->
            when (e) {
                Lifecycle.Event.ON_STOP -> store.movedToBackground()
                Lifecycle.Event.ON_START -> store.movedToForeground(visibleNow, ctx)
                else -> Unit
            }
        }
        lifecycle.addObserver(obs)
        onDispose { lifecycle.removeObserver(obs) }
    }
    // Back inside the page (its own history) before leaving the app.
    BackHandler(enabled = visible && store.canGoBack) { store.goBack() }
    val bg = MaterialTheme.colorScheme.background
    Scaffold(
        topBar = {
            TopAppBar(
                title = { if (tabSwitch != null) tabSwitch() else Text("ネタ帳", maxLines = 1) },
                actions = { TextButton(onClick = { store.reload() }) { Text("↻") } },
            )
        },
        contentWindowInsets = WindowInsets(0),
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize()) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { c -> FrameLayout(c).apply { setBackgroundColor(bg.toArgb()) } },
                update = { box ->
                    box.setBackgroundColor(bg.toArgb())
                    val w = store.web ?: return@AndroidView
                    w.setBackgroundColor(bg.toArgb())
                    if (w.parent !== box) {
                        (w.parent as? ViewGroup)?.removeView(w)
                        box.addView(w, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                    }
                },
                onRelease = { box -> store.web?.let { if (it.parent === box) box.removeView(it) } },
            )
            if (store.loading) LinearProgressIndicator(Modifier.fillMaxWidth().align(Alignment.TopCenter))
            if (store.failed) {
                Column(Modifier.align(Alignment.Center).padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("ネタ帳を読み込めませんでした", style = MaterialTheme.typography.bodyMedium)
                    OutlinedButton(onClick = { store.reload() }, modifier = Modifier.padding(top = 12.dp)) { Text("もう一度") }
                }
            }
        }
    }
}
