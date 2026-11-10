package fm.backspace.bguru.chat

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import java.io.IOException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.isActive
import okhttp3.Request

class ServerEvent(val event: String, val data: String)

/** GET /api/agent/stream (Server-Sent Events). Emits until the connection
 *  drops; the caller reconnects with backoff. */
object LiveStream {
    fun connect(token: String): Flow<ServerEvent> = flow {
        val req = Request.Builder()
            .url("${Net.BASE}/api/agent/stream")
            .header("Authorization", "Bearer $token")
            .header("Accept", "text/event-stream")
            .build()
        val call = Net.stream.newCall(req)
        // The read below blocks its thread, so a cancel (background 45 s, sign-out) was only seen at
        // the next line — up to a heartbeat (25 s) later, with the socket and the radio still up.
        // The watcher aborts the call itself, which ends the read at once.
        coroutineScope {
            val watcher = launch { try { awaitCancellation() } finally { call.cancel() } }
            try {
                call.await().use { resp ->
                    if (resp.code == 401) throw ApiError.Unauthorized(null)
                    if (resp.code != 200) throw ApiError.Http(resp.code, null, null)
                    val source = resp.body.source()
                    var name = "message"
                    val data = StringBuilder()
                    while (currentCoroutineContext().isActive) {
                        val line = source.readUtf8Line() ?: break
                        when {
                            line.isEmpty() -> {
                                if (data.isNotEmpty()) emit(ServerEvent(name, data.toString()))
                                name = "message"; data.clear()
                            }
                            line.startsWith(":") -> Unit // heartbeat
                            line.startsWith("event:") -> name = line.removePrefix("event:").trim()
                            line.startsWith("data:") -> {
                                if (data.isNotEmpty()) data.append('\n')
                                data.append(line.removePrefix("data:").trim())
                            }
                        }
                    }
                }
            } catch (e: IOException) {
                currentCoroutineContext().ensureActive() // our own abort: leave as a cancel, not a failure
                throw e
            } finally {
                watcher.cancel()
            }
        }
    }.flowOn(Dispatchers.IO)
}
