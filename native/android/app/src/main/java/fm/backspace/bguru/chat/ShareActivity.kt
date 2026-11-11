package fm.backspace.bguru.chat

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.ui.graphics.Color
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.UUID

/**
 * 共有メニューの「B-guru Chat」（2026-11-11 ドリキン）: ブラウザや他のアプリの URL・文章・写真を
 * タイムラインの投稿かチャットのメッセージとしてその場で送る。アプリ本体は開かない（送ったら閉じる）。
 */
class ShareActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Tapjacking: ignore touches while another app's window covers this one (security-reviewer 2026-11-11).
        window.decorView.filterTouchesWhenObscured = true
        val shared = SharedInput.read(intent, packageName)
        var token = TokenStore.load(this)
        var base = Net.BASE
        // Debug builds only: `adb shell am start … --es dev_token <token> --es dev_base http://10.0.2.2:<port>`
        // (kept, so a real share from another app afterwards talks to the same local server too).
        if (BuildConfig.DEBUG) {
            val dev = getSharedPreferences("share_dev", MODE_PRIVATE)
            intent.getStringExtra("dev_token")?.let { dev.edit().putString("token", it).apply() }
            intent.getStringExtra("dev_base")?.let { dev.edit().putString("base", it).apply() }
            dev.getString("token", null)?.takeIf { it.isNotBlank() }?.let { token = it }
            // Only a server on this Mac: any app could send dev_base, and the token goes there.
            dev.getString("base", null)?.takeIf { it.startsWith("http://10.0.2.2:") || it.startsWith("http://localhost:") }?.let { base = it }
        }
        setContent {
            BguruTheme {
                ShareDialog(shared, token, base, onDone = { posted ->
                    if (posted) Toast.makeText(this, "B-guru に送りました", Toast.LENGTH_SHORT).show()
                    finish()
                })
            }
        }
    }
}

/** What the other app handed us: text (subject + text/URL) and image URIs. */
data class SharedInput(val text: String, val images: List<Uri>) {
    companion object {
        fun read(intent: Intent?, ownPackage: String = ""): SharedInput {
            if (intent == null) return SharedInput("", emptyList())
            val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)?.trim().orEmpty()
            val body = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.trim().orEmpty()
            // Chrome sends the title as the subject and the URL as the text; don't repeat a title already in the text.
            val text = listOf(subject, body).filter { it.isNotEmpty() }.distinct()
                .let { parts -> if (parts.size == 2 && parts[1].contains(parts[0])) listOf(parts[1]) else parts }
                .joinToString("\n")
            val images = when (intent.action) {
                Intent.ACTION_SEND -> listOfNotNull(stream(intent))
                Intent.ACTION_SEND_MULTIPLE -> streams(intent)
                else -> emptyList()
            }.takeIf { intent.type?.startsWith("image/") == true || intent.type == "*/*" }.orEmpty()
                // Only other apps' content:// URIs: never file:// or this app's own providers, which we
                // could read with our own rights (cached DM photos…) — security-reviewer 2026-11-11.
                .filter { it.scheme == "content" && (ownPackage.isEmpty() || it.authority?.startsWith(ownPackage) != true) }
            return SharedInput(text, images.take(5))
        }

        @Suppress("DEPRECATION")
        private fun stream(i: Intent): Uri? =
            if (Build.VERSION.SDK_INT >= 33) i.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
            else i.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri

        @Suppress("DEPRECATION")
        private fun streams(i: Intent): List<Uri> =
            (if (Build.VERSION.SDK_INT >= 33) i.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
             else i.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)).orEmpty()
    }
}

private enum class ShareDestination(val label: String, val maxImages: Int, val key: String) {
    Timeline("📰 タイムライン", 5, "timeline"), Chat("💬 チャット", 4, "chat")
}

private class SharePhoto(val jpeg: ByteArray, val preview: androidx.compose.ui.graphics.ImageBitmap)

@Composable
private fun ShareDialog(input: SharedInput, token: String?, base: String, onDone: (Boolean) -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val prefs = remember { context.getSharedPreferences("share", Context.MODE_PRIVATE) }
    var dest by remember {
        mutableStateOf(if (prefs.getString("destination", null) == "chat") ShareDestination.Chat else ShareDestination.Timeline)
    }
    var text by remember { mutableStateOf(input.text) }
    var photos by remember { mutableStateOf<List<SharePhoto>>(emptyList()) }
    var loading by remember { mutableStateOf(input.images.isNotEmpty()) }
    var sending by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val focus = remember { FocusRequester() }

    LaunchedEffect(Unit) {
        if (input.images.isNotEmpty()) {
            var failed = 0
            photos = input.images.mapNotNull { uri ->
                runCatching {
                    val jpeg = ChatAttachments.jpeg(context, uri, 2048)
                    val bmp = withContext(Dispatchers.Default) {
                        android.graphics.BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size, android.graphics.BitmapFactory.Options().apply { inSampleSize = 8 })
                    }
                    SharePhoto(jpeg, bmp.asImageBitmap())
                }.getOrNull().also { if (it == null) failed++ }
            }
            if (failed > 0) error = "画像を $failed 枚読み込めませんでした"
            loading = false
        }
        if (token != null) runCatching { focus.requestFocus() }
        // Only a URL came (no title from the other app): read the page's title ourselves.
        val only = input.text.trim()
        if (input.images.isEmpty() && (only.startsWith("https://") || only.startsWith("http://")) && only.none { it.isWhitespace() }) {
            val title = PageTitle.fetch(only)
            if (title != null && text == input.text) text = "$title\n$only"
        }
    }

    val canSend = token != null && !loading && !sending && (text.isNotBlank() || photos.isNotEmpty())

    AlertDialog(
        onDismissRequest = { if (!sending) onDone(false) },
        properties = DialogProperties(usePlatformDefaultWidth = false, dismissOnClickOutside = !sending),
        modifier = Modifier.fillMaxWidth().padding(16.dp),
        title = { Text("B-guru に投稿") },
        text = {
            if (token == null) {
                Text("ログインしていません。B-guru Chat アプリを開いてログインしてから、もう一度共有してください。")
            } else Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                    ShareDestination.entries.forEachIndexed { i, d ->
                        SegmentedButton(
                            selected = dest == d,
                            onClick = { dest = d; prefs.edit().putString("destination", d.key).apply() },
                            shape = SegmentedButtonDefaults.itemShape(i, ShareDestination.entries.size),
                            colors = SegmentedButtonDefaults.colors(activeContainerColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.16f)),
                            enabled = !sending,
                            modifier = Modifier.testTag("share.${d.key}"),
                        ) { Text(d.label) }
                    }
                }
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    enabled = !sending,
                    placeholder = { Text(if (dest == ShareDestination.Timeline) "ひとこと添えて投稿" else "メッセージ") },
                    modifier = Modifier.fillMaxWidth().heightIn(min = 140.dp).focusRequester(focus).testTag("share.text"),
                )
                if (loading) CircularProgressIndicator(Modifier.size(24.dp))
                if (photos.isNotEmpty()) LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    itemsIndexed(photos) { i, p ->
                        Box {
                            Image(p.preview, contentDescription = null, contentScale = ContentScale.Crop,
                                modifier = Modifier.size(72.dp).clip(RoundedCornerShape(8.dp))
                                    .alpha(if (i < dest.maxImages) 1f else 0.3f))
                            Box(
                                Modifier.align(Alignment.TopEnd).padding(3.dp).size(22.dp)
                                    .background(Color.Black.copy(alpha = 0.55f), CircleShape)
                                    .clickable(enabled = !sending) { photos = photos.filterIndexed { j, _ -> j != i } },
                                contentAlignment = Alignment.Center,
                            ) { Icon(Icons.Default.Close, "写真 ${i + 1} を外す", tint = Color.White, modifier = Modifier.size(14.dp)) }
                        }
                    }
                }
                Text(
                    buildString {
                        append(if (dest == ShareDestination.Timeline) "部活は自動で選ばれます。URL はリンクのカードになります。" else "部室のチャットにみんな向けに送ります。")
                        if (photos.size > dest.maxImages) append(" 写真は ${dest.maxImages} 枚まで（薄い写真は送りません）。")
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
        },
        confirmButton = {
            if (token != null) Row(verticalAlignment = Alignment.CenterVertically) {
                if (sending) CircularProgressIndicator(Modifier.size(20.dp).padding(end = 8.dp))
                TextButton(
                    enabled = canSend,
                    modifier = Modifier.testTag("share.send"),
                    onClick = {
                        sending = true; error = null
                        val body = text.trim()
                        val jpegs = photos.take(dest.maxImages).map { it.jpeg }
                        val d = dest
                        scope.launch {
                            val r = runCatching { ShareSender(token, base).send(d == ShareDestination.Chat, body, jpegs) }
                            sending = false
                            r.onSuccess { onDone(true) }.onFailure { error = it.message ?: "送れませんでした" }
                        }
                    },
                ) { Text("投稿") }
            }
        },
        dismissButton = {
            TextButton(onClick = { onDone(false) }, enabled = !sending) { Text(if (token == null) "閉じる" else "キャンセル") }
        },
    )
}

/** The page's title (og:title, else <title>) for a URL shared without one. Short timeout, first 512 KB only. */
object PageTitle {
    suspend fun fetch(url: String): String? = withContext(Dispatchers.IO) {
        runCatching {
            val client = Net.http.newBuilder().callTimeout(5, java.util.concurrent.TimeUnit.SECONDS).build()
            val req = Request.Builder().url(url)
                .header("User-Agent", "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36")
                .build()
            client.newCall(req).execute().use { r ->
                if (!r.isSuccessful) return@use null
                val type = r.header("Content-Type").orEmpty()
                if (type.isNotEmpty() && !type.contains("html")) return@use null
                val src = r.body?.source() ?: return@use null
                src.request(512L * 1024)
                val bytes = src.buffer.readByteArray(minOf(src.buffer.size, 512L * 1024))
                parse(decode(bytes, type))
            }
        }.getOrNull()
    }

    /** UTF-8 unless the header or a <meta charset> says otherwise (many Japanese sites are Shift_JIS / EUC-JP). */
    private fun decode(bytes: ByteArray, contentType: String): String {
        val re = Regex("""charset=["']?([A-Za-z0-9_\-]+)""", RegexOption.IGNORE_CASE)
        val head = String(bytes, 0, minOf(bytes.size, 4096), Charsets.UTF_8)
        val name = re.find(contentType)?.groupValues?.get(1) ?: re.find(head)?.groupValues?.get(1)
        val cs = name?.let { runCatching { java.nio.charset.Charset.forName(it) }.getOrNull() } ?: Charsets.UTF_8
        return String(bytes, cs)
    }

    fun parse(html: String): String? {
        val patterns = listOf(
            Regex("""<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']""", RegexOption.IGNORE_CASE),
            Regex("""<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']""", RegexOption.IGNORE_CASE),
            Regex("""<title[^>]*>([^<]+)</title>""", RegexOption.IGNORE_CASE),
        )
        for (re in patterns) {
            val t = re.find(html)?.groupValues?.get(1)?.let(::decode)?.replace('\n', ' ')?.trim().orEmpty()
            if (t.isNotEmpty()) return t.take(200)
        }
        return null
    }

    private fun decode(s: String) = s.replace("&amp;", "&").replace("&quot;", "\"").replace("&#39;", "'")
        .replace("&#x27;", "'").replace("&lt;", "<").replace("&gt;", ">").replace("&nbsp;", " ")
}

/** The two or three calls a share makes, with the app's token (and its shared HTTP client). */
private class ShareSender(private val token: String, private val base: String) {
    suspend fun send(chat: Boolean, body: String, jpegs: List<ByteArray>) = withContext(Dispatchers.IO) {
        val urls = if (jpegs.isEmpty()) emptyList()
                   else upload(if (chat) "/api/agent/chat/upload" else "/api/agent/upload", jpegs)
        val json = if (chat) buildJsonObject {
            put("body", body); put("client_id", UUID.randomUUID().toString())
            if (urls.isNotEmpty()) put("images", JsonArray(urls.map { JsonPrimitive(it) }))
        } else buildJsonObject {
            put("text", body); put("images", JsonArray(urls.map { JsonPrimitive(it) }))
        }
        call(Request.Builder().url(base + if (chat) "/api/agent/chat" else "/api/agent/publish")
            .post(json.toString().toRequestBody("application/json".toMediaType())))
    }

    private fun upload(path: String, jpegs: List<ByteArray>): List<String> {
        val form = MultipartBody.Builder().setType(MultipartBody.FORM).apply {
            jpegs.forEachIndexed { i, b -> addFormDataPart("images", "photo$i.jpg", b.toRequestBody("image/jpeg".toMediaType())) }
        }.build()
        val text = call(Request.Builder().url(base + path).post(form), longer = true)
        val urls = runCatching {
            ApiJson.parseToJsonElement(text).let { it as kotlinx.serialization.json.JsonObject }["urls"]
                .let { it as JsonArray }.map { (it as JsonPrimitive).content }
        }.getOrNull()
        if (urls == null || urls.size != jpegs.size) throw IllegalStateException("写真を送れませんでした")
        return urls
    }

    private fun call(b: Request.Builder, longer: Boolean = false): String {
        val client = if (longer) Net.http.newBuilder().callTimeout(120, java.util.concurrent.TimeUnit.SECONDS)
            .readTimeout(120, java.util.concurrent.TimeUnit.SECONDS).build() else Net.http
        val resp = try { client.newCall(b.header("Authorization", "Bearer $token").build()).execute() }
                   catch (e: java.io.IOException) { throw IllegalStateException("送れませんでした。電波を確かめてもう一度お試しください") }
        resp.use { r ->
            val text = r.body?.string().orEmpty()
            if (r.isSuccessful) return text
            if (r.code == 401) throw IllegalStateException("ログインが切れています。B-guru Chat アプリを開いてログインし直してください")
            val msg = runCatching {
                (ApiJson.parseToJsonElement(text) as kotlinx.serialization.json.JsonObject)["error"]?.let { (it as JsonPrimitive).content }
            }.getOrNull()
            throw IllegalStateException(msg?.takeIf { it.isNotBlank() } ?: "送れませんでした（${r.code}）")
        }
    }
}
