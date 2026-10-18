package fm.backspace.bguru.chat

import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import kotlin.math.max

/** A photo attached to a chat message: the JPEG that will be uploaded and a small
 *  preview for the composer and the pending bubble. The full-size decode is dropped
 *  as soon as both exist, so a pending message holds ~1.5 MB per photo, not ~6.5. */
class ChatPhoto(val jpeg: ByteArray, val preview: ImageBitmap)

/** Photos attached in the chat composer (at most `max`). */
class ChatAttachments {
    var photos by mutableStateOf<List<ChatPhoto>>(emptyList()); private set
    /** Photos being decoded (a large original can take a moment). */
    var loading by mutableIntStateOf(0); private set
    var error by mutableStateOf<String?>(null)

    fun remaining(max: Int) = (max - photos.size - loading).coerceAtLeast(0)

    suspend fun add(context: Context, uris: List<Uri>, max: Int, maxSide: Int) {
        val take = uris.take(remaining(max))
        if (take.isEmpty()) return
        var failed = 0
        loading += take.size
        val loaded = try {
            take.mapNotNull { uri ->
                runCatching { load(context, uri, maxSide) }
                    .onFailure { if (BuildConfig.DEBUG) android.util.Log.d("BguruChat", "photo decode failed", it) }
                    .getOrNull().also { if (it == null) failed++ }
            }
        } finally { loading -= take.size }
        photos = (photos + loaded).take(max)
        error = if (failed > 0) "画像を $failed 枚読み込めませんでした" else null
    }

    fun remove(i: Int) { photos = photos.filterIndexed { idx, _ -> idx != i } }

    /** Hands the photos to a send and empties the composer. */
    fun take(): List<ChatPhoto> = photos.also { photos = emptyList(); error = null }

    /** A send was refused: put the photos back unless new ones were attached meanwhile. */
    fun restore(p: List<ChatPhoto>) { if (photos.isEmpty()) photos = p }

    companion object {
        private const val PREVIEW_SIDE = 720
        private const val QUALITY = 80

        /** Decoded at most `maxSide` on the long side (ImageDecoder applies the EXIF
         *  rotation) and re-encoded as JPEG, so location and other EXIF never leave the phone. */
        private suspend fun load(context: Context, uri: Uri, maxSide: Int): ChatPhoto {
            val full = withContext(Dispatchers.IO) {
                ImageDecoder.decodeBitmap(ImageDecoder.createSource(context.contentResolver, uri)) { decoder, info, _ ->
                    val w = info.size.width
                    val h = info.size.height
                    val scale = minOf(1.0, maxSide.toDouble() / max(w, h))
                    decoder.setTargetSize((w * scale).toInt().coerceAtLeast(1), (h * scale).toInt().coerceAtLeast(1))
                    decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE // compress() needs a software bitmap
                }
            }
            return withContext(Dispatchers.Default) {
                val jpeg = ByteArrayOutputStream().use { out ->
                    full.compress(Bitmap.CompressFormat.JPEG, QUALITY, out)
                    out.toByteArray()
                }
                val scale = minOf(1.0, PREVIEW_SIDE.toDouble() / max(full.width, full.height))
                val preview = if (scale < 1.0) {
                    Bitmap.createScaledBitmap(full, (full.width * scale).toInt().coerceAtLeast(1), (full.height * scale).toInt().coerceAtLeast(1), true)
                        .also { full.recycle() }
                } else full
                ChatPhoto(jpeg, preview.asImageBitmap())
            }
        }
    }
}
