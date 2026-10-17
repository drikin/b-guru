package fm.backspace.bguru.chat

import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import kotlin.math.max

/** Text + up to 5 photos, shared by a new post and a thread reply (same as
 *  PostDraft in native/shared/ComposeSheet.swift). Photos are decoded at most
 *  2048 px on the long side (ImageDecoder also applies the EXIF rotation) and
 *  re-encoded as JPEG, so location and other EXIF never leave the phone. */
class PostDraft(val maxImages: Int) {
    var text by mutableStateOf("")
    var images by mutableStateOf<List<Bitmap>>(emptyList()); private set
    var sending by mutableStateOf(false); private set
    /** Photos being decoded (a large original can take a moment). */
    var loading by mutableStateOf(0); private set
    var error by mutableStateOf<String?>(null)

    val canSend get() = !sending && loading == 0 && (text.isNotBlank() || images.isNotEmpty())
    val remaining get() = (maxImages - images.size).coerceAtLeast(0)

    suspend fun add(context: Context, uris: List<Uri>) {
        var failed = 0
        loading += uris.size
        val loaded = try { withContext(Dispatchers.IO) {
            uris.take(remaining).mapNotNull { uri ->
                runCatching { decode(context, uri) }
                    .onFailure { if (BuildConfig.DEBUG) android.util.Log.d("BguruDraft", "decode failed", it) }
                    .getOrNull().also { if (it == null) failed++ }
            }
        } } finally { loading -= uris.size }
        images = images + loaded
        if (BuildConfig.DEBUG) android.util.Log.d("BguruDraft", "added ${loaded.size}, now ${images.size}")
        error = if (failed > 0) "画像を $failed 枚読み込めませんでした" else null
    }

    fun remove(i: Int) { images = images.filterIndexed { idx, _ -> idx != i } }

    /** Upload the photos, then publish. Returns the stored post, or null (error set). */
    suspend fun send(api: ApiClient, parentId: Long?): Post? {
        if (!canSend) return null
        sending = true
        error = null
        try {
            val urls = if (images.isEmpty()) emptyList() else {
                val jpegs = withContext(Dispatchers.Default) { images.map(::jpeg) }
                api.upload(jpegs)
            }
            val post = api.publish(text.trim(), urls, parentId)
            text = ""
            images = emptyList()
            return post
        } catch (e: ApiError) {
            error = when (e) {
                is ApiError.Http -> e.serverMessage ?: "投稿できませんでした"
                is ApiError.Unauthorized -> "ログインが切れました。再接続してください"
                is ApiError.Transport -> "通信できませんでした。もう一度お試しください"
            }
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Exception) {
            error = "投稿できませんでした"
        } finally {
            sending = false
        }
        return null
    }

    companion object {
        private const val MAX_SIDE = 2048

        fun decode(context: Context, uri: Uri): Bitmap {
            val source = ImageDecoder.createSource(context.contentResolver, uri)
            return ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
                val w = info.size.width
                val h = info.size.height
                val scale = minOf(1.0, MAX_SIDE.toDouble() / max(w, h))
                decoder.setTargetSize((w * scale).toInt().coerceAtLeast(1), (h * scale).toInt().coerceAtLeast(1))
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE // compress() needs a software bitmap
            }
        }

        fun jpeg(bitmap: Bitmap): ByteArray = ByteArrayOutputStream().use { out ->
            bitmap.compress(Bitmap.CompressFormat.JPEG, 82, out)
            out.toByteArray()
        }
    }
}
