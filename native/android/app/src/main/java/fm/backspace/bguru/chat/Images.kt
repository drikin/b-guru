package fm.backspace.bguru.chat

import android.graphics.BitmapFactory
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
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import okhttp3.Request

/** Avatars and custom emoji are small: fetched once per launch and kept in memory,
 *  so scrolling and live updates never refetch. */
object ImageCache {
    private val cache = LruCache<String, ImageBitmap>(300)
    /** Uploaded images (/api/media/…) need the member's token: the app has no web session. */
    @Volatile var token: String? = null

    fun peek(url: String): ImageBitmap? = cache.get(url)

    suspend fun load(url: String): ImageBitmap? {
        cache.get(url)?.let { return it }
        return withContext(Dispatchers.IO) {
            runCatching {
                val req = Request.Builder().url(url).apply {
                    // Only our own server (same scheme, host, port) ever gets the token.
                    val t = token
                    if (t != null && url.startsWith(Net.BASE + "/")) header("Authorization", "Bearer $t")
                }.build()
                Net.http.newCall(req).execute().use { r ->
                    if (!r.isSuccessful) return@use null
                    val bytes = r.body.bytes()
                    val opts = BitmapFactory.Options().apply { inPreferredConfig = android.graphics.Bitmap.Config.ARGB_8888 }
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)?.asImageBitmap()
                }
            }.getOrNull()?.also { cache.put(url, it) }
        }
    }
}

@Composable
fun RemoteImage(url: String?, modifier: Modifier, contentScale: ContentScale = ContentScale.Crop, fallback: @Composable () -> Unit = {}) {
    val abs = ApiClient.absolute(url)
    var bmp by remember(abs) { mutableStateOf(abs?.let(ImageCache::peek)) }
    LaunchedEffect(abs) { if (abs != null && bmp == null) bmp = ImageCache.load(abs) }
    val b = bmp
    if (b != null) Image(b, contentDescription = null, modifier = modifier, contentScale = contentScale) else fallback()
}

@Composable
fun Avatar(url: String?, name: String, size: Dp = 28.dp) {
    val m = Modifier.size(size).clip(CircleShape)
    RemoteImage(url, m) {
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
