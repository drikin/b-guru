package fm.backspace.bguru.chat

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.launch
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/** First run: sign in to B-guru in an embedded web view, then the app issues
 *  itself a device token (read / read_state / chat / post) with that page's session
 *  cookie and keeps only the token. The web session is wiped right after. No JS
 *  bridge is installed, and navigation is confined to bsm.backspace.fm. */
@Composable
fun LoginScreen(onToken: (String) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var status by remember { mutableStateOf<String?>(null) }
    var showDevices by remember { mutableStateOf(false) }
    var working by remember { mutableStateOf(false) }
    var web by remember { mutableStateOf<WebView?>(null) }

    Surface(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().statusBarsPadding()) {
            AndroidView(
                modifier = Modifier.weight(1f).fillMaxWidth(),
                factory = { ctx -> newLoginWebView(ctx).also { web = it } },
            )
            HorizontalDivider()
            Row(
                Modifier.fillMaxWidth().navigationBarsPadding().padding(12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Column(Modifier.weight(1f)) {
                    Text(
                        status ?: "B-guru にログインしてから「このアプリを接続」を押してください",
                        style = MaterialTheme.typography.bodyMedium,
                        color = if (status == null) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                    )
                    if (showDevices) {
                        TextButton(onClick = { web?.loadUrl("${Net.BASE}/settings/agent") }) { Text("デバイスの管理を開く") }
                    }
                }
                Button(enabled = !working, onClick = {
                    working = true
                    status = null
                    scope.launch {
                        try {
                            val token = issueToken(context)
                            clearWebSession()
                            onToken(token)
                        } catch (e: IssueError) {
                            status = e.message
                            showDevices = e.isLimit
                        } catch (e: Exception) {
                            status = "接続できませんでした。ログインしているか確認してください"
                            showDevices = false
                        } finally {
                            working = false
                        }
                    }
                }) { Text(if (working) "接続中…" else "このアプリを接続") }
            }
        }
    }
}

private class IssueError(message: String, val isLimit: Boolean = false) : Exception(message)

@SuppressLint("SetJavaScriptEnabled")
private fun newLoginWebView(ctx: Context): WebView {
    clearWebSession() // start signed out: a previous user's session never carries over
    return WebView(ctx).apply {
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                if (u.scheme == "https" && u.host == Uri.parse(Net.BASE).host) return false
                // Anything else opens in the browser, never inside the login view.
                runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                return true
            }
        }
        loadUrl(Net.BASE)
    }
}

private fun clearWebSession() {
    CookieManager.getInstance().removeAllCookies(null)
    CookieManager.getInstance().flush()
    WebStorage.getInstance().deleteAllData()
}

/** Per-device name for the token. `replace_same_device` revokes tokens with the
 *  SAME name, so it must differ between a member's devices. */
@SuppressLint("HardwareIds")
fun deviceName(ctx: Context): String {
    val id = Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ANDROID_ID)?.take(6) ?: "000000"
    return "B-guru Chat (Android) ${Build.MODEL} $id".take(100)
}

private suspend fun issueToken(ctx: Context): String {
    val cookie = CookieManager.getInstance().getCookie(Net.BASE)
    if (cookie.isNullOrBlank()) throw IssueError("まだログインしていません。上の画面で B-guru にログインしてください")
    val body = buildJsonObject {
        put("device_name", deviceName(ctx))
        putJsonArray("scopes") { add("read"); add("read_state"); add("chat"); add("post") }
        put("replace_same_device", true)
    }.toString().toRequestBody("application/json".toMediaType())
    // No Origin header (a direct API client) — the route accepts that; the
    // session cookie is the proof of sign-in.
    val req = Request.Builder().url("${Net.BASE}/api/agent/token").header("Cookie", cookie).post(body).build()
    Net.http.newCall(req).await().use { resp ->
        val r = runCatching { ApiJson.decodeFromString<TokenIssueResponse>(resp.body.string()) }.getOrNull()
        if (resp.code == 201 && !r?.token.isNullOrEmpty()) return r!!.token
        val error = r?.error.orEmpty()
        when (resp.code) {
            401 -> throw IssueError("まだログインしていません。上の画面で B-guru にログインしてください")
            403 -> throw IssueError(error.ifEmpty { "会員資格が確認できませんでした" })
            else -> {
                val text = listOf(error, r?.hint.orEmpty()).filter { it.isNotEmpty() }.joinToString("。")
                throw IssueError(text.ifEmpty { "接続できませんでした（${resp.code}）" }, isLimit = error.contains("本まで"))
            }
        }
    }
}
