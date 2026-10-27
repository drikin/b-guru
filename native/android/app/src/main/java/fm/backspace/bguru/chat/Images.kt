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
    /** One download per image, shared by the rows that want it; cancelled (the HTTP call
     *  too) when every one of them has gone — a row scrolled past before its photo came. */
    private class Load(val job: kotlinx.coroutines.Deferred<ImageBitmap?>) { var waiters = 0 }
    private val inFlight = HashMap<String, Load>()
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

    /** Width / height of images seen so far (by absolute URL): a photo shown again — scrolled
     *  back to, or in the thread — gets its own shape at once instead of a placeholder's. */
    private val ratios = LruCache<String, Float>(4000)

    fun ratio(url: String?): Float? = url?.let { ratios.get(it) }

    private fun noteRatio(url: String, w: Int, h: Int) { if (w > 0 && h > 0) ratios.put(url, w.toFloat() / h) }

    /** An animated image (GIF) as a drawable that plays: decoded at most `maxPx` on its long
     *  side. Frames are decoded as it plays (not all kept), so it costs about two frames of
     *  memory. Not cached in memory — the bytes come from the disk cache. Null when it is not
     *  animated after all (draw it with [RemoteImage]) or could not be loaded. */
    suspend fun loadAnimated(url: String, maxPx: Int): android.graphics.drawable.AnimatedImageDrawable? = withContext(decoding) {
        val req = Request.Builder().url(url).apply {
            val t = token
            if (t != null && url.startsWith(Net.BASE + "/")) header("Authorization", "Bearer $t")
        }.build()
        val call = http.newCall(req)
        val hook = kotlinx.coroutines.currentCoroutineContext()[kotlinx.coroutines.Job]?.invokeOnCompletion { if (it != null) call.cancel() }
        try {
            runCatching {
                call.execute().use { r ->
                    if (!r.isSuccessful) return@use null
                    val bytes = r.body.bytes()
                    ImageDecoder.decodeDrawable(ImageDecoder.createSource(java.nio.ByteBuffer.wrap(bytes))) { d, info, _ ->
                        val w = info.size.width
                        val h = info.size.height
                        val scale = minOf(1.0, maxPx.toDouble() / maxOf(w, h))
                        if (scale < 1.0) d.setTargetSize((w * scale).toInt().coerceAtLeast(1), (h * scale).toInt().coerceAtLeast(1))
                    }.also { noteRatio(url, it.intrinsicWidth, it.intrinsicHeight) } as? android.graphics.drawable.AnimatedImageDrawable
                }
            }.getOrNull()
        } finally {
            hook?.dispose()
        }
    }

    /** The image at most `maxPx` on its long side (aspect kept). Main thread. */
    suspend fun load(url: String, maxPx: Int): ImageBitmap? {
        val k = key(url, maxPx)
        cache.get(k)?.let { return it }
        val load = inFlight[k] ?: Load(scope.async(start = kotlinx.coroutines.CoroutineStart.LAZY) {
            try {
                withContext(decoding) { fetch(url, maxPx) }?.also { cache.put(k, it) }
            } finally {
                if (inFlight[k]?.job === coroutineContext[kotlinx.coroutines.Job]) inFlight.remove(k)
            }
        }).also { inFlight[k] = it; it.job.start() }
        load.waiters++
        try {
            return load.job.await()
        } finally {
            if (--load.waiters == 0 && !load.job.isCompleted) {
                load.job.cancel()
                if (inFlight[k] === load) inFlight.remove(k)
            }
        }
    }

    private suspend fun fetch(url: String, maxPx: Int): ImageBitmap? {
        val req = Request.Builder().url(url).apply {
            // Only our own server (same scheme, host, port) ever gets the token.
            val t = token
            if (t != null && url.startsWith(Net.BASE + "/")) header("Authorization", "Bearer $t")
        }.build()
        val call = http.newCall(req)
        // Cancelled (nobody wants it any more): abort the download itself.
        val hook = kotlinx.coroutines.currentCoroutineContext()[kotlinx.coroutines.Job]?.invokeOnCompletion { if (it != null) call.cancel() }
        try {
            return runCatching { decode(call, maxPx, url) }.getOrNull()
        } finally {
            hook?.dispose()
        }
    }

    private fun decode(call: okhttp3.Call, maxPx: Int, url: String): ImageBitmap? =
        call.execute().use { r ->
            if (!r.isSuccessful) return@use null
            val bytes = r.body.bytes()
            if (call.isCanceled()) return@use null
            // ImageDecoder scales while decoding (no full-size bitmap ever exists) and
            // applies the EXIF rotation. Hardware bitmaps live in GPU memory, not the heap.
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(java.nio.ByteBuffer.wrap(bytes))) { d, info, _ ->
                val w = info.size.width
                val h = info.size.height
                val scale = minOf(1.0, maxPx.toDouble() / maxOf(w, h))
                if (scale < 1.0) d.setTargetSize((w * scale).toInt().coerceAtLeast(1), (h * scale).toInt().coerceAtLeast(1))
            }.also { noteRatio(url, it.width, it.height) }.asImageBitmap()
        }
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

/** Custom emoji (`:name:`): the agent API's list (GET /api/agent/emojis, capabilities
 *  `custom_emoji_list`) or, on an older server, the web's /api/emojis. */
object EmojiCatalog {
    @Serializable private data class Item(val name: String, val imageUrl: String)
    @Serializable private data class ListResp(val emojis: List<Item> = emptyList())

    /** name → absolute image URL, in the server's order (the picker shows them in this order). */
    @Volatile var urls: Map<String, String> = emptyMap(); private set

    val names: List<String> get() = urls.keys.sorted()

    /** name → id（エージェント API の一覧のときだけ。削除に使う）。 */
    @Volatile var ids: Map<String, Long> = emptyMap(); private set

    /** Bumped when the list arrives (the picker recomposes). */
    var version by androidx.compose.runtime.mutableIntStateOf(0); private set

    private fun set(list: Map<String, String>) { urls = list; version++ }

    suspend fun load() {
        if (urls.isNotEmpty()) return
        val text = withContext(Dispatchers.IO) {
            runCatching { Net.http.newCall(Request.Builder().url("${Net.BASE}/api/emojis").build()).execute().use { it.body.string() } }.getOrNull()
        } ?: return
        // /api/emojis is camelCase (shared with the web), not the agent API's snake_case.
        val list = runCatching { kotlinx.serialization.json.Json { ignoreUnknownKeys = true }.decodeFromString<ListResp>(text) }.getOrNull() ?: return
        set(LinkedHashMap(list.emojis.mapNotNull { e -> ApiClient.absolute(e.imageUrl)?.let { e.name to it } }.toMap()))
    }

    private var loadedAt = 0L

    /** The agent API's list (with the token); falls back to [load] when it fails.
     *  Fetched again at most hourly: every return to the app used to refetch it. */
    suspend fun load(api: ApiClient, path: String?, force: Boolean = false) {
        if (path == null) return load()
        if (!force && urls.isNotEmpty() && System.currentTimeMillis() - loadedAt < 60 * 60_000L) return
        val list = runCatching { api.customEmojis(path) }.getOrNull() ?: return load()
        ids = list.filter { it.id > 0 }.associate { it.name to it.id }
        set(LinkedHashMap(list.mapNotNull { e -> ApiClient.absolute(e.imageUrl)?.let { e.name to it } }.toMap()))
        loadedAt = System.currentTimeMillis()
    }

    /** Demo only: pictures served from this Mac. */
    fun loadDemo(list: Map<String, String>) = set(LinkedHashMap(list))
}
