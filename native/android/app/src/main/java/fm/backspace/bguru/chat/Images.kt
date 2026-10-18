package fm.backspace.bguru.chat

import android.graphics.ImageDecoder
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import okhttp3.Request

/** Avatars, custom emoji and post photos. Every image is decoded at the size it is
 *  shown (never the original — a phone photo is 4032×3024 = 48 MB as a bitmap, and a
 *  few of those ran the app out of memory while scrolling the timeline), kept in a
 *  memory cache bounded by bytes, and fetched once even when many rows ask at once.
 *  Responses also go through a small disk cache, so a relaunch does not refetch. */
object ImageCache {
    private const val MEMORY_BYTES = 48 * 1024 * 1024
    private val cache = object : LruCache<String, ImageBitmap>(MEMORY_BYTES) {
        override fun sizeOf(key: String, value: ImageBitmap) = value.width * value.height * 4
    }
    /** Uploaded images (/api/media/…) need the member's token: the app has no web session. */
    @Volatile var token: String? = null
    private val inFlight = HashMap<String, kotlinx.coroutines.Deferred<ImageBitmap?>>()
    private val scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.SupervisorJob() + Dispatchers.Main.immediate)
    /** Decoding is memory-heavy: a few at a time, off the main thread. */
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    private val decoding = Dispatchers.IO.limitedParallelism(3)
    @Volatile private var http: okhttp3.OkHttpClient = Net.http

    fun init(context: android.content.Context) {
        http = Net.http.newBuilder()
            .cache(okhttp3.Cache(java.io.File(context.cacheDir, "images"), 64L * 1024 * 1024))
            .build()
    }

    private fun key(url: String, maxPx: Int) = "$url@$maxPx"

    fun peek(url: String, maxPx: Int): ImageBitmap? = cache.get(key(url, maxPx))

    /** The image at most `maxPx` on its long side (aspect kept). Main thread. */
    suspend fun load(url: String, maxPx: Int): ImageBitmap? {
        val k = key(url, maxPx)
        cache.get(k)?.let { return it }
        val job = inFlight[k] ?: scope.async {
            try {
                withContext(decoding) { fetch(url, maxPx) }?.also { cache.put(k, it) }
            } finally {
                inFlight.remove(k)
            }
        }.also { inFlight[k] = it }
        return job.await()
    }

    private fun fetch(url: String, maxPx: Int): ImageBitmap? = runCatching {
        val req = Request.Builder().url(url).apply {
            // Only our own server (same scheme, host, port) ever gets the token.
            val t = token
            if (t != null && url.startsWith(Net.BASE + "/")) header("Authorization", "Bearer $t")
        }.build()
        http.newCall(req).execute().use { r ->
            if (!r.isSuccessful) return@use null
            val bytes = r.body.bytes()
            // ImageDecoder scales while decoding (no full-size bitmap ever exists) and
            // applies the EXIF rotation. Hardware bitmaps live in GPU memory, not the heap.
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(java.nio.ByteBuffer.wrap(bytes))) { d, info, _ ->
                val w = info.size.width
                val h = info.size.height
                val scale = minOf(1.0, maxPx.toDouble() / maxOf(w, h))
                if (scale < 1.0) d.setTargetSize((w * scale).toInt().coerceAtLeast(1), (h * scale).toInt().coerceAtLeast(1))
            }.asImageBitmap()
        }
    }.getOrNull()
}

/** `maxPx`: the longest side the image is shown at (decoded no larger). */
@Composable
fun RemoteImage(
    url: String?,
    modifier: Modifier,
    contentScale: ContentScale = ContentScale.Crop,
    maxPx: Int = 1080,
    fallback: @Composable () -> Unit = {},
) {
    val abs = ApiClient.absolute(url)
    var bmp by remember(abs, maxPx) { mutableStateOf(abs?.let { ImageCache.peek(it, maxPx) }) }
    LaunchedEffect(abs, maxPx) { if (abs != null && bmp == null) bmp = ImageCache.load(abs, maxPx) }
    val b = bmp
    if (b != null) Image(b, contentDescription = null, modifier = modifier, contentScale = contentScale) else fallback()
}

@Composable
fun Avatar(url: String?, name: String, size: Dp = 28.dp) {
    val m = Modifier.size(size).clip(CircleShape)
    val px = with(androidx.compose.ui.platform.LocalDensity.current) { size.roundToPx() }
    RemoteImage(url, m, maxPx = px) {
        Box(m.background(MaterialTheme.colorScheme.surfaceVariant), contentAlignment = Alignment.Center) {
            Text(name.take(1), fontSize = (size.value * 0.45).sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** Custom emoji (`:name:`) from /api/emojis. */
object EmojiCatalog {
    @Serializable private data class Item(val name: String, val imageUrl: String)
    @Serializable private data class ListResp(val emojis: List<Item> = emptyList())

    @Volatile var urls: Map<String, String> = emptyMap(); private set

    val names: List<String> get() = urls.keys.sorted()

    suspend fun load() {
        if (urls.isNotEmpty()) return
        val text = withContext(Dispatchers.IO) {
            runCatching { Net.http.newCall(Request.Builder().url("${Net.BASE}/api/emojis").build()).execute().use { it.body.string() } }.getOrNull()
        } ?: return
        // /api/emojis is camelCase (shared with the web), not the agent API's snake_case.
        val list = runCatching { kotlinx.serialization.json.Json { ignoreUnknownKeys = true }.decodeFromString<ListResp>(text) }.getOrNull() ?: return
        urls = list.emojis.mapNotNull { e -> ApiClient.absolute(e.imageUrl)?.let { e.name to it } }.toMap()
    }
}
