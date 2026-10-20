package fm.backspace.bguru.chat

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/* 「ネタ帳に送る」 (docs/neta-client-spec.md, drikin 2026-10-20): the article a timeline post
 * links to → BS ネタ帳 (https://neta.backspace.fm, a PUBLIC site). Never the post's own
 * B-guru URL, and never the post's text (members-only) unless the member types it. */

// Same rules as the web (src/lib/neta-client.ts): a URL stops at Japanese brackets and
// punctuation, and loses trailing 。、)）」』】,.!?！？.
private val NETA_URL_RE = Regex("""https?://[^\s<>"'　「」『』【】（）、。]+""", RegexOption.IGNORE_CASE)
private val NETA_TRAILING_RE = Regex("""[。、)）」』】,.!?！？]+$""")

/** The URLs a post can send: the link card's first, then http(s) URLs in the text
 *  (trailing 。、)」』】,.!? dropped), without bsm.backspace.fm or user info, each once. */
fun netaCandidates(text: String, previewUrl: String?): List<String> {
    val raw = buildList {
        previewUrl?.let(::add)
        NETA_URL_RE.findAll(text).forEach { add(it.value.replace(NETA_TRAILING_RE, "")) }
    }
    val out = LinkedHashSet<String>()
    for (r in raw) netaNormalize(r.trim())?.let(out::add)
    return out.toList()
}

/** http(s) with a host, no user info, not B-guru itself; a bare host gets "/" (like the web's URL.href). */
private fun netaNormalize(url: String): String? {
    val m = Regex("""^(https?)://([^/?#]*)(.*)$""", RegexOption.IGNORE_CASE).find(url) ?: return null
    val (scheme, authority, rest) = m.destructured
    if (authority.isEmpty() || '@' in authority) return null
    val host = authority.substringBefore(':').lowercase()
    if (host.isEmpty() || host == "bsm.backspace.fm") return null
    return "${scheme.lowercase()}://${authority.lowercase()}${if (rest.isEmpty() || rest[0] != '/') "/$rest" else rest}"
}

/** What the member sees after a send: (sent, text). */
fun netaResultMessage(status: Int, body: NetaResponse?): Pair<Boolean, String> = when {
    status in 200..299 && body?.ok != false -> true to "ネタ帳に送りました"
    status == 409 && body?.existing != null ->
        false to "今週のネタ帳には ${body.existing.submitter ?: "だれか"} さんが「${body.existing.title ?: ""}」として投稿済みです"
    !body?.error.isNullOrBlank() -> false to body!!.error!!
    status == 401 -> false to "ログインし直してください"
    else -> false to "ネタ帳に送れませんでした（$status）"
}

/** The confirm dialog (ネタ帳は公開サイトなので、送る前に必ず出す). */
@Composable
fun NetaDialog(post: Post, candidates: List<String>, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var url by remember { mutableStateOf(candidates.first()) }
    // The card's title only when the chosen URL is the card's (compared normalized).
    val cardUrl = remember(post.urlPreview?.url) { netaCandidates("", post.urlPreview?.url).firstOrNull() }
    fun cardTitle(u: String) = if (u == cardUrl) post.urlPreview?.title?.trim().orEmpty() else ""
    var title by remember { mutableStateOf(cardTitle(url)) }
    var description by remember { mutableStateOf("") }   // starts EMPTY: never the post's text
    var sending by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var sent by remember { mutableStateOf(false) }
    val session = App.session(context)
    val caps = session.store?.capabilities
    val site = caps?.netaSite ?: "https://neta.backspace.fm"

    if (sent) {
        AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text("ネタ帳に送りました") },
            text = { Text(title, maxLines = 3, overflow = TextOverflow.Ellipsis) },
            confirmButton = {
                TextButton(onClick = {
                    onDismiss()
                    context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(site)))
                }) { Text("ネタ帳を開く") }
            },
            dismissButton = { TextButton(onClick = onDismiss) { Text("閉じる") } },
        )
        return
    }

    val canSend = title.isNotBlank() && !sending
    AlertDialog(
        onDismissRequest = { if (!sending) onDismiss() },
        title = { Text("ネタ帳に送る") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (candidates.size == 1) {
                    Text(url, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 2, overflow = TextOverflow.Ellipsis)
                } else {
                    Text("URL", style = MaterialTheme.typography.labelMedium)
                    candidates.forEach { c ->
                        Row(
                            Modifier.fillMaxWidth().selectable(selected = c == url, enabled = !sending, role = Role.RadioButton) {
                                if (c != url) {
                                    // Keep what the member typed; swap only the card title we put in.
                                    if (title.isBlank() || title == cardTitle(url)) title = cardTitle(c)
                                    url = c
                                }
                            },
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(selected = c == url, onClick = null)
                            Text(c, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f))
                        }
                    }
                }
                OutlinedTextField(title, { title = it.take(200) }, label = { Text("題名（必須）") },
                    enabled = !sending, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(description, { description = it.take(1000) }, label = { Text("説明（任意）") },
                    enabled = !sending, minLines = 2, modifier = Modifier.fillMaxWidth())
                Text("ネタ帳は公開サイトです。B-guru の表示名で投稿されます。",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            TextButton(enabled = canSend, onClick = {
                sending = true; error = null
                scope.launch {
                    val store = session.store
                    val (ok, message) = try {
                        if (store == null) false to "ログインし直してください"
                        // Demo (debug builds): never the network — ネタ帳 is a public site.
                        else if (store.demo) { delay(600); true to "ネタ帳に送りました" }
                        else {
                            val (status, body) = store.api.sendNeta(url, title.trim(), description.trim(), caps?.netaPath ?: "/api/agent/neta")
                            netaResultMessage(status, body)
                        }
                    } catch (e: Exception) {
                        if (e is kotlinx.coroutines.CancellationException) throw e
                        false to "ネタ帳に送れませんでした（通信エラー）"
                    }
                    sending = false
                    if (ok) sent = true else error = message
                }
            }) { Text(if (sending) "送信中…" else "送る") }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !sending) { Text("キャンセル") } },
    )
}
