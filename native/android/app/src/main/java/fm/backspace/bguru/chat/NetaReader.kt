package fm.backspace.bguru.chat

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView

/**
 * 📝 ネタ帳の元記事をネタ帳の中で読む（2026-11-27 オーナー「内蔵のブラウザでネタ帳のビューの中でその記事を表示できる
 * オプションも追加してほしくて、そっちをデフォルトに」）。ネタ帳のページがほかのサイトへ行こうとしたら、設定が
 * 「アプリの中で開く」（既定）ならネタ帳の上にこのブラウザを重ねる。切ると今までどおり普段のブラウザで開く。
 * 中のリンクはこの中で進む。http(s) 以外は OS に渡す。鍵はどの読み込みにも付けない。
 */
class NetaReader {
    var url by mutableStateOf<String?>(null); private set
    var title by mutableStateOf(""); private set
    var loading by mutableStateOf(false); private set
    var canGoBack by mutableStateOf(false); private set
    var canGoForward by mutableStateOf(false); private set
    var web by mutableStateOf<WebView?>(null); private set

    /** ほかのサイトへのリンク: 設定に合わせてここか普段のブラウザで。Main thread. */
    fun open(ctx: Context, link: Uri) {
        val s = link.scheme?.lowercase()
        if ((s != "http" && s != "https") || !inApp(ctx)) { openOutside(ctx, link); return }
        val w = web ?: make(ctx.applicationContext).also { web = it }
        url = link.toString()
        title = link.host ?: ""
        w.loadUrl(link.toString())
    }

    fun close() {
        val w = web
        web = null
        url = null
        title = ""
        loading = false
        canGoBack = false
        canGoForward = false
        if (w != null) Handler(Looper.getMainLooper()).post {
            (w.parent as? ViewGroup)?.removeView(w)
            w.stopLoading()
            w.destroy()
        }
    }

    fun back() { web?.takeIf { it.canGoBack() }?.goBack() }
    fun forward() { web?.takeIf { it.canGoForward() }?.goForward() }
    fun reload() { web?.reload() }
    val current: String? get() = web?.url ?: url

    fun openCurrentOutside(ctx: Context) { current?.let { openOutside(ctx, Uri.parse(it)) } }

    fun share(ctx: Context) {
        val u = current ?: return
        val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, u).putExtra(Intent.EXTRA_SUBJECT, title)
        runCatching { ctx.startActivity(Intent.createChooser(send, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }

    private fun sync(view: WebView) {
        canGoBack = view.canGoBack()
        canGoForward = view.canGoForward()
        view.title?.takeIf { it.isNotBlank() && !it.startsWith("http") }?.let { title = it }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun make(ctx: Context): WebView = WebView(ctx).apply {
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.setGeolocationEnabled(false)
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.javaScriptCanOpenWindowsAutomatically = false
        settings.setSupportMultipleWindows(true)
        settings.mediaPlaybackRequiresUserGesture = true
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val s = request.url.scheme?.lowercase()
                if (s == "http" || s == "https") return false
                if (request.isForMainFrame) openOutside(view.context, request.url)
                return true
            }
            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) { loading = true; sync(view) }
            override fun onPageFinished(view: WebView, url: String?) { loading = false; sync(view) }
            override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) { sync(view) }
        }
        webChromeClient = object : WebChromeClient() {
            override fun onReceivedTitle(view: WebView, t: String?) { sync(view) }
            // target=_blank (on a tap): find its URL with a throwaway WebView and load it here.
            override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
                if (!isUserGesture) return false
                val probe = WebView(view.context)
                probe.webViewClient = object : WebViewClient() {
                    private var done = false
                    private fun take(w: WebView, u: Uri?): Boolean {
                        if (!done && u != null) {
                            done = true
                            val s = u.scheme?.lowercase()
                            if (s == "https" || s == "http") view.loadUrl(u.toString()) else openOutside(view.context, u)
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
        }
    }

    companion object {
        private const val PREFS = "neta"
        private const val KEY = "open_links_in_app"

        /** 既定はアプリの中。 */
        fun inApp(ctx: Context): Boolean = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY, true)
        fun setInApp(ctx: Context, on: Boolean) { ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY, on).apply() }

        fun openOutside(ctx: Context, url: Uri) {
            runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        }
    }
}

/** ネタ帳の上に重ねる記事のブラウザ（バー＋WebView）。reader.url があるときだけ。 */
@Composable
fun NetaReaderOverlay(reader: NetaReader, ctx: Context) {
    if (reader.url == null) return
    val bg = MaterialTheme.colorScheme.background
    Column(Modifier.fillMaxSize().background(bg)) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { reader.close() }, modifier = Modifier.semantics { contentDescription = "ネタ帳に戻る" }) { Text("✕") }
            TextButton(onClick = { reader.back() }, enabled = reader.canGoBack) { Text("‹") }
            TextButton(onClick = { reader.forward() }, enabled = reader.canGoForward) { Text("›") }
            Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(reader.title, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                reader.current?.let { Uri.parse(it).host }?.let {
                    Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                }
            }
            TextButton(onClick = { reader.reload() }) { Text("↻") }
            TextButton(onClick = { reader.share(ctx) }) { Text("共有") }
            TextButton(onClick = { reader.openCurrentOutside(ctx) }) { Text("ブラウザ") }
        }
        HorizontalDivider()
        Box(Modifier.fillMaxSize()) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { c -> FrameLayout(c) },
                update = { box ->
                    val w = reader.web ?: return@AndroidView
                    if (w.parent !== box) {
                        (w.parent as? ViewGroup)?.removeView(w)
                        box.addView(w, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                    }
                },
                onRelease = { box -> reader.web?.let { if (it.parent === box) box.removeView(it) } },
            )
            if (reader.loading) LinearProgressIndicator(Modifier.fillMaxWidth().align(Alignment.TopCenter))
        }
    }
}
