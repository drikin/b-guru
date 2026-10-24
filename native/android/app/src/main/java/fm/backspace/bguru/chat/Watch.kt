package fm.backspace.bguru.chat

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Color as AColor
import android.net.Uri
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/*
 * 📺 YouTube 共同鑑賞 (src/lib/watch.ts). The player is the server's /watch/index.html in a WebView — the same
 * page the web and the Apple apps show — loaded straight from production (YouTube refuses an embed without a
 * real https origin, so the page is not served from the app or its assets). The page keeps no token: its
 * actions come here (BguruWatchBridge) and go to /api/agent/watch/action; the state goes back to the page.
 * While open, the WebView belongs to the store, so moving it between the chat column and the floating
 * window never restarts the video. Main thread.
 */

object WatchLogic {
    /** The page's script call for one message to it. */
    fun receiveScript(msg: JsonObject): String = "window.bguruWatch&&window.bguruWatch.receive(${JsonPrimitive(msg.toString())});"

    /** A YouTube video link (the 「みんなで見る」 mark; the server checks it). */
    fun isVideoUrl(s: String): Boolean {
        val u = runCatching { java.net.URI(s) }.getOrNull() ?: return false
        if (u.scheme != "https" && u.scheme != "http") return false
        val host = u.host?.lowercase() ?: return false
        val id = Regex("^[A-Za-z0-9_-]{11}$")
        val p = (u.path ?: "").split('/').filter { it.isNotEmpty() }
        if (host == "youtu.be") return p.firstOrNull()?.let(id::matches) == true
        if (host != "youtube.com" && !host.endsWith(".youtube.com")) return false
        val v = (u.rawQuery ?: "").split('&').firstNotNullOfOrNull { kv -> kv.split('=', limit = 2).takeIf { it.size == 2 && it[0] == "v" }?.get(1) }
        if (v != null && id.matches(v)) return true
        return p.size >= 2 && p[0] in setOf("shorts", "live", "embed") && id.matches(p[1])
    }

    /** The first YouTube video link in a chat message (its 「みんなで見る」). */
    fun firstVideoUrl(text: String): String? {
        if (!text.contains("youtu")) return null
        return Regex("""https?://[^\s<>"']+""").findAll(text).map { it.value.trimEnd('.', ',', ')', '」', '）') }.firstOrNull(::isVideoUrl)
    }

    /** Hosts the player page may load in its frames (YouTube and what it pulls in). */
    fun isPlayerSubresource(u: Uri?): Boolean = u?.scheme == "https"
}

/** 📺 for the 「みんなで見る」 buttons on YouTube links (null when off for this member). */
val LocalWatch = androidx.compose.runtime.staticCompositionLocalOf<WatchStore?> { null }

class WatchStore(private val api: ApiClient) {
    enum class Mode { DOCKED, FLOATING }

    var enabled by mutableStateOf(false); private set
    var canControl by mutableStateOf(true); private set
    var open by mutableStateOf(false); private set
    var mode by mutableStateOf(Mode.DOCKED); private set
    var title by mutableStateOf<String?>(null); private set
    var basePath = "/api/agent/watch"; private set
    var playerUrl = "/watch/index.html"; private set

    /** The player (made when first opened, kept while open). */
    var web: WebView? = null; private set
    private var ready = false
    private var lastState: JsonObject? = null
    private var lastVersion = -1
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    fun configure(caps: Capabilities?) {
        enabled = caps?.watchEnabled == true
        canControl = caps?.canControlWatch == true
        caps?.let { basePath = it.watchPath; playerUrl = it.watchPlayerUrl }
        if (enabled) scope.launch { reload() } else close()
    }

    val compact get() = mode == Mode.FLOATING

    fun show(context: Context) {
        if (!enabled) return
        if (web == null) web = makeWebView(context.applicationContext)
        open = true
    }

    fun toggle(context: Context) = if (open) close() else show(context)

    fun close() {
        open = false
        mode = Mode.DOCKED
        ready = false
        web?.let { w ->
            (w.parent as? ViewGroup)?.removeView(w)
            w.stopLoading()
            if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                runCatching { WebViewCompat.removeWebMessageListener(w, "BguruWatchBridge") }
            }
            w.destroy()
        }
        web = null
    }

    fun switchTo(m: Mode) {
        if (m == mode) return
        mode = m
        send(buildJsonObject { put("type", "layout"); put("compact", compact) })
    }

    private fun send(msg: JsonObject) {
        val w = web ?: return
        if (!ready) return
        w.evaluateJavascript(WatchLogic.receiveScript(msg), null)
    }

    private fun sendState(s: JsonObject) = send(buildJsonObject { put("type", "state"); put("state", s) })

    suspend fun reload() {
        if (!enabled) return
        try {
            val (status, body) = api.minigame("GET", "state", base = basePath)
            if (status == 200) (body?.get("state") as? JsonObject)?.let { take(it, force = true) }
        } catch (e: CancellationException) { throw e } catch (_: Exception) { }
    }

    /** The stream's `event: watch` ({ state }). */
    fun onStreamEvent(data: String) {
        val s = runCatching { ApiJson.parseToJsonElement(data).jsonObject["state"] as? JsonObject }.getOrNull() ?: return
        take(s)
    }

    private fun take(s: JsonObject, force: Boolean = false) {
        val v = s["version"]?.jsonPrimitive?.intOrNull ?: 0
        if (!force && v < lastVersion) return
        lastVersion = v
        lastState = s
        val video = s["video"] as? JsonObject
        title = video?.get("title")?.jsonPrimitive?.content
        sendState(s)
    }

    /** An action from the page (or 「みんなで見る」) → the API; the answer's state back to the page. */
    fun act(body: JsonObject) {
        if (!enabled || !canControl) return
        scope.launch {
            try {
                val (status, out) = api.minigame("POST", "action", body, basePath)
                val s = out?.get("state") as? JsonObject
                if (status == 200 && s != null) take(s) else {
                    val message = out?.get("error")?.jsonPrimitive?.content ?: "うまくいきませんでした（$status）"
                    send(buildJsonObject { put("type", "error"); put("message", message) })
                }
            } catch (e: CancellationException) { throw e } catch (_: Exception) {
                send(buildJsonObject { put("type", "error"); put("message", "通信できませんでした") })
            }
        }
    }

    /** A YouTube link's 「みんなで見る」: on now when nothing is, otherwise into the list. Opens the player. */
    fun watchTogether(context: Context, url: String, floating: Boolean = false) {
        if (!enabled) return
        // From the timeline: float over it (the docked player is on the chat page).
        if (floating && !open) mode = Mode.FLOATING
        show(context)
        val busy = lastState?.get("video") is JsonObject
        act(buildJsonObject { put("action", if (busy) "queue_add" else "load"); put("url", url) })
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun makeWebView(ctx: Context): WebView {
        val base = Uri.parse(Net.BASE)
        val page = Uri.parse(Net.BASE + playerUrl)
        return WebView(ctx).apply {
            setBackgroundColor(AColor.BLACK)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.javaScriptCanOpenWindowsAutomatically = false
            settings.setSupportMultipleWindows(false)
            settings.setSupportZoom(false)
            settings.setGeolocationEnabled(false)
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            // Joining with the sound on (the page also has 🔊).
            settings.mediaPlaybackRequiresUserGesture = false
            CookieManager.getInstance().setAcceptThirdPartyCookies(this, false)
            webChromeClient = WebChromeClient()
            webViewClient = object : WebViewClient() {
                private fun isPage(u: Uri?) = u != null && u.scheme == "https" && u.host == base.host && u.path == page.path

                // Main-frame navigations: only the player page; a link (「YouTube で見る」) goes to the browser.
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    if (!request.isForMainFrame) return !WatchLogic.isPlayerSubresource(request.url)
                    if (isPage(request.url)) return false
                    if (request.url.scheme == "https") runCatching {
                        view.context.startActivity(Intent(Intent.ACTION_VIEW, request.url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    }
                    return true
                }

                override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                    ready = false
                }
            }
            // Messages from the page: only its main frame on our origin (a JavascriptInterface would be open to
            // the YouTube frame and anything it loads — security review 2026-10-25). Older WebViews without the
            // listener get no bridge: the player then only shows.
            if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                WebViewCompat.addWebMessageListener(this, "BguruWatchBridge", setOf("https://${base.host}")) { _, message, origin, isMainFrame, _ ->
                    if (!isMainFrame || origin.scheme != "https" || origin.host != base.host) return@addWebMessageListener
                    val m = message.data?.let { runCatching { ApiJson.parseToJsonElement(it) as? JsonObject }.getOrNull() } ?: return@addWebMessageListener
                    receive(m)
                }
            }
            loadUrl(page.toString())
        }
    }

    /** From the page (main thread). */
    internal fun receive(m: JsonObject) {
        when (m["type"]?.jsonPrimitive?.content) {
            "ready" -> {
                ready = true
                send(buildJsonObject {
                    put("type", "hello"); put("bridge", 1); put("platform", "android")
                    put("can_control", canControl); put("compact", compact)
                })
                lastState?.let(::sendState)
            }
            "action" -> (m["body"] as? JsonObject)?.let(::act)
            "popout" -> switchTo(if (mode == Mode.DOCKED) Mode.FLOATING else Mode.DOCKED)
            else -> Unit // a newer page's message
        }
    }
}

/** The store's WebView, put into this place (taken from wherever it was). Nothing is destroyed here. */
@Composable
fun WatchPlayerHost(store: WatchStore, modifier: Modifier = Modifier) {
    AndroidView(
        modifier = modifier,
        factory = { ctx -> FrameLayout(ctx).apply { setBackgroundColor(AColor.BLACK) } },
        update = { box ->
            val w = store.web ?: return@AndroidView
            if (w.parent !== box) {
                (w.parent as? ViewGroup)?.removeView(w)
                box.addView(w, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            }
        },
        onRelease = { box -> store.web?.let { if (it.parent === box) box.removeView(it) } },
    )
}

/** Docked: above the chat, about half the column at most (the chat stays in view). */
@Composable
fun WatchDock(store: WatchStore, maxHeight: Dp) {
    val h = (maxHeight * 0.5f).coerceIn(220.dp, 560.dp)
    WatchPlayerHost(store, Modifier.fillMaxWidth().height(h))
}

/** 📺 beside テキスト｜ルーム｜☗｜🎮 (the player stays open whatever the chat shows). Red dot: a video is on. */
@Composable
fun WatchToggle(store: WatchStore) {
    val ctx = LocalContext.current
    TextButton(onClick = { store.toggle(ctx) }) {
        Text("📺", fontSize = 16.sp)
        if (store.title != null && !store.open) {
            Box(Modifier.padding(start = 3.dp).size(6.dp).clip(CircleShape).background(Color.Red))
        }
    }
}

/** A YouTube link's 「📺 みんなで見る」 (chat / timeline), only when on for this member. */
@Composable
fun WatchTogetherButton(store: WatchStore, url: String, floating: Boolean = false) {
    if (!store.enabled || !store.canControl) return
    val ctx = LocalContext.current
    OutlinedButton(onClick = { store.watchTogether(ctx, url, floating) }, modifier = Modifier.height(32.dp)) {
        Text(if (store.title == null) "📺 みんなで見る" else "📺 見たいものリストへ", fontSize = 12.sp)
    }
}

/**
 * Floating over the app: dragged by its title bar, settles in the nearest corner, two sizes, ⤓ back above
 * the chat, ✕ closes. Only the picture and the page's bar.
 */
@Composable
fun WatchFloating(store: WatchStore) {
    val conf = LocalConfiguration.current
    val density = LocalDensity.current
    var large by remember { mutableStateOf(false) }
    var corner by remember { mutableIntStateOf(3) } // 0 top-left, 1 top-right, 2 bottom-left, 3 bottom-right
    var dx by remember { mutableStateOf(0f) }
    var dy by remember { mutableStateOf(0f) }
    val screenW = conf.screenWidthDp.dp
    val screenH = conf.screenHeightDp.dp
    val w = minOf(screenW - 16.dp, if (large) 360.dp else 240.dp)
    val h = w * 9f / 16f + 44.dp + 28.dp
    val margin = 8.dp
    val left = corner % 2 == 0
    val top = corner < 2
    val baseX = with(density) { (if (left) margin else screenW - margin - w).toPx() }
    val baseY = with(density) { (if (top) margin + 64.dp else screenH - margin - h - 96.dp).toPx() }
    Popup(
        offset = IntOffset((baseX + dx).toInt(), (baseY + dy).toInt()),
        properties = PopupProperties(focusable = false, clippingEnabled = true),
    ) {
        Surface(shape = RoundedCornerShape(12.dp), shadowElevation = 10.dp, modifier = Modifier.width(w).height(h)) {
            Column {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.fillMaxWidth().height(28.dp)
                        .background(MaterialTheme.colorScheme.surfaceContainerHigh)
                        .pointerInput(Unit) {
                            detectDragGestures(
                                onDrag = { change, amount -> change.consume(); dx += amount.x; dy += amount.y },
                                onDragEnd = {
                                    val cx = baseX + dx + with(density) { w.toPx() } / 2
                                    val cy = baseY + dy + with(density) { h.toPx() } / 2
                                    corner = (if (cy < with(density) { screenH.toPx() } / 2) 0 else 2) + (if (cx < with(density) { screenW.toPx() } / 2) 0 else 1)
                                    dx = 0f; dy = 0f
                                },
                            )
                        }
                        .padding(start = 10.dp),
                ) {
                    Text("📺 ${store.title ?: "みんなで見る"}", fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
                        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    TextButton(onClick = { large = !large }) { Text(if (large) "↙" else "↗", fontSize = 13.sp) }
                    TextButton(onClick = { store.switchTo(WatchStore.Mode.DOCKED) }) { Text("⤓", fontSize = 13.sp) }
                    TextButton(onClick = { store.close() }) { Text("✕", fontSize = 13.sp) }
                }
                WatchPlayerHost(store, Modifier.fillMaxWidth().weight(1f))
            }
        }
    }
}
