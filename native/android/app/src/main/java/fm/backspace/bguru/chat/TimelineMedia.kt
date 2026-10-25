package fm.backspace.bguru.chat

import android.content.Context
import android.graphics.drawable.AnimatedImageDrawable
import android.graphics.drawable.Drawable
import android.media.MediaMetadataRetriever
import android.os.Handler
import android.os.Looper
import android.util.LruCache
import android.view.SurfaceView
import androidx.annotation.OptIn
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.RememberObserver
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

// The timeline's photos, GIFs, videos and sounds, drawn the web's way (src/app/page.tsx): photos
// never cut, GIFs moving, video and audio played right in the post. Sizes come from TimelineRules.

/** 1 photo: its own shape, at most 360 dp wide (and 480 tall); 2: two columns; 3–5: three.
 *  Never cropped. Tap → full screen. */
@Composable
fun PostImages(images: List<String>, columns: Int, onOpen: (Int) -> Unit) {
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val avail = maxWidth.value
        if (images.size == 1 || columns == 1) {
            val abs = ApiClient.absolute(images[0])
            var ratio by remember(abs) { mutableStateOf(ImageCache.ratio(abs)) }
            val (w, h) = TimelineRules.singleImageSize(avail, ratio ?: (4f / 3f))
            val shape = RoundedCornerShape(10.dp)
            Box(Modifier.size(w.dp, h.dp).clip(shape).background(MaterialTheme.colorScheme.surfaceVariant).clickable { onOpen(0) }) {
                PostPhoto(images[0], Modifier.fillMaxSize(), maxPx = 1080) { ratio = it }
            }
            return@BoxWithConstraints
        }
        val cols = columns.takeIf { it in 2..3 } ?: TimelineRules.imageColumns(images.size)
        val gap = 4f
        val cell = (avail - gap * (cols - 1)) / cols
        Column(verticalArrangement = Arrangement.spacedBy(gap.dp)) {
            images.withIndex().chunked(cols).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(gap.dp), verticalAlignment = Alignment.Top) {
                    row.forEach { (i, path) ->
                        val abs = ApiClient.absolute(path)
                        var ratio by remember(abs) { mutableStateOf(ImageCache.ratio(abs)) }
                        val h = TimelineRules.gridCellHeight(cell, ratio ?: 1f)
                        Box(Modifier.size(cell.dp, h.dp).clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.surfaceVariant).clickable { onOpen(i) }) {
                            PostPhoto(path, Modifier.fillMaxSize(), maxPx = 540) { ratio = it }
                        }
                    }
                }
            }
        }
    }
}

/** A photo fitted into its box (no cropping); a GIF plays. `onRatio`: its width / height once known. */
@Composable
internal fun PostPhoto(url: String, modifier: Modifier, maxPx: Int, onRatio: (Float) -> Unit) {
    if (TimelineRules.isAnimated(url)) {
        AnimatedRemoteImage(url, modifier, maxPx, onRatio)
        return
    }
    val abs = ApiClient.absolute(url)
    var bmp by remember(abs, maxPx) { mutableStateOf(abs?.let { ImageCache.peek(it, maxPx) }) }
    LaunchedEffect(abs, maxPx) { if (abs != null && bmp == null) bmp = ImageCache.load(abs, maxPx) }
    val b = bmp ?: return
    LaunchedEffect(b) { if (b.height > 0) onRatio(b.width.toFloat() / b.height) }
    Image(b, contentDescription = null, modifier = modifier, contentScale = ContentScale.Fit)
}

/** A GIF that moves while it is on screen (and the app in front), still otherwise. A row
 *  scrolled away is disposed, which stops it and lets its frames go. */
@Composable
private fun AnimatedRemoteImage(url: String, modifier: Modifier, maxPx: Int, onRatio: (Float) -> Unit) {
    val abs = ApiClient.absolute(url) ?: return
    var drawable by remember(abs) { mutableStateOf<AnimatedImageDrawable?>(null) }
    var notAnimated by remember(abs) { mutableStateOf(false) }
    LaunchedEffect(abs) {
        val d = ImageCache.loadAnimated(abs, maxPx)
        if (d == null) notAnimated = true else { drawable = d; if (d.intrinsicHeight > 0) onRatio(d.intrinsicWidth.toFloat() / d.intrinsicHeight) }
    }
    if (notAnimated) {
        // A still image named .gif, or it failed: the ordinary photo path.
        var bmp by remember(abs) { mutableStateOf(ImageCache.peek(abs, maxPx)) }
        LaunchedEffect(abs) { if (bmp == null) bmp = ImageCache.load(abs, maxPx) }
        bmp?.let { b ->
            LaunchedEffect(b) { if (b.height > 0) onRatio(b.width.toFloat() / b.height) }
            Image(b, null, modifier, contentScale = ContentScale.Fit)
        }
        return
    }
    val d = drawable ?: return
    val painter = remember(d) { DrawablePainter(d) }
    LifecycleStartEffect(d) {
        d.start()
        onStopOrDispose { d.stop() }
    }
    Image(painter, contentDescription = "GIF", modifier = modifier, contentScale = ContentScale.Fit)
}

/** Draws an animated drawable and redraws (draw phase only) on each of its frames. */
private class DrawablePainter(private val drawable: Drawable) : Painter(), RememberObserver {
    private var frame by mutableIntStateOf(0)
    private val main = Handler(Looper.getMainLooper())
    // Drawable keeps its callback weakly: held here for as long as the painter lives.
    private val callback = object : Drawable.Callback {
        override fun invalidateDrawable(who: Drawable) { frame++ }
        override fun scheduleDrawable(who: Drawable, what: Runnable, `when`: Long) { main.postAtTime(what, `when`) }
        override fun unscheduleDrawable(who: Drawable, what: Runnable) { main.removeCallbacks(what) }
    }

    override fun onRemembered() { drawable.callback = callback }
    override fun onForgotten() { drawable.callback = null }
    override fun onAbandoned() { drawable.callback = null }

    override val intrinsicSize: Size
        get() = if (drawable.intrinsicWidth > 0 && drawable.intrinsicHeight > 0) Size(drawable.intrinsicWidth.toFloat(), drawable.intrinsicHeight.toFloat()) else Size.Unspecified

    override fun DrawScope.onDraw() {
        frame // read: a new frame redraws
        drawIntoCanvas { c ->
            drawable.setBounds(0, 0, size.width.toInt(), size.height.toInt())
            drawable.draw(c.nativeCanvas)
        }
    }
}

/** The first frame of a video, for the ▶ cover (the web shows the same with preload="metadata").
 *  Only on a network that is not metered (Wi-Fi, not mobile data): seeing a post must not spend
 *  the member's data. Elsewhere the cover is ▶ and 「動画」 until played. */
private object VideoFrames {
    private val cache = object : LruCache<String, ImageBitmap>(12 * 1024 * 1024) {
        override fun sizeOf(key: String, value: ImageBitmap) = value.width * value.height * 4
    }
    /** One at a time: reading a frame over the network is heavy. */
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    private val io = Dispatchers.IO.limitedParallelism(1)

    fun peek(url: String): ImageBitmap? = cache.get(url)

    fun allowed(context: Context): Boolean {
        val cm = context.getSystemService(android.net.ConnectivityManager::class.java) ?: return false
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
    }

    suspend fun load(url: String, maxPx: Int): ImageBitmap? = cache.get(url) ?: withContext(io) {
        val r = MediaMetadataRetriever()
        try {
            // Through OkHttp (not the platform's player stack): the member's token goes to our
            // own server only, and OkHttp drops it on a redirect to another host.
            r.setDataSource(RangeSource(url))
            r.getScaledFrameAtTime(0, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, maxPx, maxPx)?.asImageBitmap()
        } catch (_: Exception) {
            null
        } finally {
            runCatching { r.release() }
        }
    }?.also { cache.put(url, it) }

    /** A video read in 512 KB ranges; gives up after 8 MB (a file whose index is at its end). */
    private class RangeSource(private val url: String) : android.media.MediaDataSource() {
        private var size = -1L
        private var start = -1L
        private var buf = ByteArray(0)
        private var fetched = 0L

        override fun getSize(): Long { if (size < 0) fill(0); return size }

        override fun readAt(position: Long, buffer: ByteArray, offset: Int, length: Int): Int {
            if (size in 0..position) return -1
            if (start < 0 || position < start || position >= start + buf.size) fill(position)
            if (position < start || position >= start + buf.size) return -1
            val from = (position - start).toInt()
            val n = minOf(length, buf.size - from)
            System.arraycopy(buf, from, buffer, offset, n)
            return n
        }

        private fun fill(pos: Long) {
            if (fetched > LIMIT) throw java.io.IOException("too much for a cover")
            val req = okhttp3.Request.Builder().url(url).header("Range", "bytes=$pos-${pos + CHUNK - 1}").apply {
                InlineMedia.headersFor(url).forEach { (k, v) -> header(k, v) }
            }.build()
            Net.http.newCall(req).execute().use { r ->
                if (!r.isSuccessful) throw java.io.IOException("HTTP ${r.code}")
                if (r.code == 206) {
                    r.header("Content-Range")?.substringAfter('/')?.toLongOrNull()?.let { size = it }
                    buf = r.body.bytes(); start = pos
                } else {
                    // No ranges: the whole file, if it is small enough.
                    val len = r.body.contentLength()
                    if (len < 0 || len > LIMIT) throw java.io.IOException("no ranges")
                    buf = r.body.bytes(); start = 0; size = buf.size.toLong()
                }
                fetched += buf.size
            }
        }

        override fun close() {}

        companion object {
            const val CHUNK = 512 * 1024
            const val LIMIT = 8L * 1024 * 1024
        }
    }
}

/** The one player for videos and sounds in posts (the jukebox has its own, JukeboxStore). One
 *  plays at a time; starting another stops it. Built when first played, released when stopped,
 *  so a timeline nobody plays from holds no decoder. Takes audio focus: the jukebox pauses. */
@OptIn(UnstableApi::class)
object InlineMedia {
    /** The URL loaded (playing or paused), or null. */
    var current by mutableStateOf<String?>(null); private set
    var playing by mutableStateOf(false); private set
    var buffering by mutableStateOf(false); private set
    /** The playing video's width / height. */
    var videoRatio by mutableStateOf<Float?>(null); private set
    var durationMs by mutableLongStateOf(0L); private set
    private var player: ExoPlayer? = null

    fun headersFor(url: String): Map<String, String> {
        val t = ImageCache.token
        return if (t != null && url.startsWith(Net.BASE + "/")) mapOf("Authorization" to "Bearer $t") else emptyMap()
    }

    private fun build(context: Context): ExoPlayer {
        // OkHttp (the app's client): it drops Authorization when a redirect goes to another host,
        // which DefaultHttpDataSource does not (it re-sends every request header).
        val http = androidx.media3.datasource.okhttp.OkHttpDataSource.Factory(Net.media).setUserAgent(Net.USER_AGENT)
        // Our own server's media needs the member's token; nobody else ever gets it.
        val auth = ResolvingDataSource.Factory(DefaultDataSource.Factory(context, http)) { spec ->
            val h = headersFor(spec.uri.toString())
            if (h.isEmpty()) spec else spec.withAdditionalHeaders(h)
        }
        return ExoPlayer.Builder(context)
            .setMediaSourceFactory(DefaultMediaSourceFactory(auth))
            .build().also { p ->
                p.addListener(object : Player.Listener {
                    override fun onIsPlayingChanged(isPlaying: Boolean) { playing = isPlaying }
                    override fun onPlaybackStateChanged(state: Int) {
                        buffering = state == Player.STATE_BUFFERING
                        if (state == Player.STATE_READY) durationMs = p.duration.coerceAtLeast(0)
                        if (state == Player.STATE_ENDED) { p.pause(); p.seekTo(0) }
                    }
                    override fun onVideoSizeChanged(size: VideoSize) {
                        if (size.width > 0 && size.height > 0) videoRatio = size.width * size.pixelWidthHeightRatio / size.height
                    }
                })
            }
    }

    private val attributes = AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build()

    fun play(context: Context, url: String) {
        val p = player ?: build(context.applicationContext).also { player = it }
        // Audio focus pauses the jukebox — but never in the voice room: taking focus from the
        // call (LiveKit holds it) could duck or route it. There the post's sound just mixes in,
        // as on iOS (PostMedia.swift: the call's audio session is left alone).
        val inCall = App.session(context).store?.voice?.phase?.let { it != VoiceStore.Phase.IDLE } == true
        p.setAudioAttributes(attributes, !inCall)
        if (current != url) {
            p.setMediaItem(MediaItem.fromUri(url))
            p.prepare()
            current = url
            videoRatio = null
            durationMs = 0
        }
        p.play()
    }

    fun toggle(context: Context, url: String) { if (current == url && playing) player?.pause() else play(context, url) }

    fun pause() { player?.pause() }

    fun seekTo(ms: Long) { player?.seekTo(ms) }

    fun positionMs(): Long = player?.currentPosition ?: 0L

    /** Stop and let the decoder go. */
    fun stop() {
        player?.release()
        player = null
        current = null
        playing = false
        buffering = false
        videoRatio = null
        durationMs = 0
    }

    fun attach(view: SurfaceView) { player?.setVideoSurfaceView(view) }
    fun detach(view: SurfaceView) { player?.clearVideoSurfaceView(view) }
}

/** A post's video: its first frame with ▶ (the web's), tapped → plays right here with a
 *  seek bar. At most 560 dp wide and 420 tall, black around it. Stops when scrolled away
 *  or when the app goes to the background. */
@Composable
fun PostVideo(url: String) {
    val context = LocalContext.current
    val abs = ApiClient.absolute(url) ?: return
    val active = InlineMedia.current == abs
    var frame by remember(abs) { mutableStateOf(VideoFrames.peek(abs)) }
    val px = with(LocalDensity.current) { 560.dp.roundToPx() }
    LaunchedEffect(abs) { if (frame == null && VideoFrames.allowed(context)) frame = VideoFrames.load(abs, px) }
    val ratio = (if (active) InlineMedia.videoRatio else null) ?: frame?.let { it.width.toFloat() / it.height } ?: (16f / 9f)
    DisposableEffect(abs) { onDispose { if (InlineMedia.current == abs) InlineMedia.stop() } }
    LifecycleStartEffect(abs) { onStopOrDispose { if (InlineMedia.current == abs) InlineMedia.pause() } }

    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val w = minOf(maxWidth.value, 560f)
        val h = minOf(w / ratio, 420f)
        val shape = RoundedCornerShape(12.dp)
        Box(Modifier.size(w.dp, h.dp).clip(shape).background(Color.Black), contentAlignment = Alignment.Center) {
            Box(Modifier.aspectRatio(ratio), contentAlignment = Alignment.Center) {
                if (active) {
                    AndroidView(
                        factory = { SurfaceView(it).also(InlineMedia::attach) },
                        onRelease = InlineMedia::detach,
                        modifier = Modifier.fillMaxSize(),
                    )
                }
                if (!active || InlineMedia.videoRatio == null) {
                    frame?.let { Image(it, null, Modifier.fillMaxSize(), contentScale = ContentScale.Fit) }
                }
            }
            if (active) {
                Box(Modifier.fillMaxSize().clickable { InlineMedia.toggle(context, abs) })
                MediaControls(abs, dark = true, modifier = Modifier.align(Alignment.BottomCenter).fillMaxWidth()
                    .background(Color.Black.copy(alpha = 0.45f)).padding(horizontal = 6.dp))
            } else {
                Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.22f)).clickable { InlineMedia.play(context, abs) }
                    .semantics { contentDescription = "動画を再生" }, contentAlignment = Alignment.Center) {
                    PlayDisc()
                    if (frame == null) {
                        Text("動画", color = Color.White.copy(alpha = 0.85f), style = MaterialTheme.typography.labelLarge,
                            modifier = Modifier.align(Alignment.BottomStart).padding(10.dp))
                    }
                }
            }
        }
    }
}

@Composable
private fun PlayDisc() {
    Box(Modifier.size(52.dp).background(Color.Black.copy(alpha = 0.7f), CircleShape), contentAlignment = Alignment.Center) {
        Text("▶", color = Color.White, fontSize = 20.sp)
    }
}

/** A post's sound (not a jukebox episode): a small player — ▶, seek bar, time. Nothing is
 *  fetched until ▶ (the web: preload "none" for outside audio, which counts downloads). */
@Composable
fun PostAudio(url: String) {
    val context = LocalContext.current
    val abs = ApiClient.absolute(url) ?: return
    val active = InlineMedia.current == abs
    DisposableEffect(abs) { onDispose { if (InlineMedia.current == abs) InlineMedia.stop() } }
    LifecycleStartEffect(abs) { onStopOrDispose { if (InlineMedia.current == abs) InlineMedia.pause() } }
    val shape = RoundedCornerShape(12.dp)
    Box(Modifier.widthIn(max = 560.dp).fillMaxWidth().clip(shape).background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.06f)).padding(horizontal = 6.dp)) {
        if (active) {
            MediaControls(abs, dark = false)
        } else {
            Row(Modifier.fillMaxWidth().height(44.dp).clickable { InlineMedia.play(context, abs) }.semantics { contentDescription = "音声を再生" },
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("▶", fontSize = 18.sp, color = AccentGreen, modifier = Modifier.width(36.dp).padding(start = 12.dp))
                Box(Modifier.weight(1f).height(4.dp).background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.15f), CircleShape))
                Text("♪ 音声", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(end = 8.dp))
            }
        }
    }
}

/** ▶/❚❚, the seek bar and the time, for the media loaded in [InlineMedia]. */
@Composable
private fun MediaControls(url: String, dark: Boolean, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    var pos by remember { mutableLongStateOf(0L) }
    var dragging by remember { mutableStateOf<Float?>(null) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    // The position: read once on every change (pause, the end, buffering), then 4 times a
    // second only while playing and on screen — nothing moves while paused.
    LaunchedEffect(url, InlineMedia.playing, InlineMedia.buffering) {
        if (dragging == null) pos = InlineMedia.positionMs()
        if (!InlineMedia.playing) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) {
                if (dragging == null) pos = InlineMedia.positionMs()
                delay(250)
            }
        }
    }
    val dur = InlineMedia.durationMs
    val fg = if (dark) Color.White else MaterialTheme.colorScheme.onSurface
    Row(modifier.height(44.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(if (InlineMedia.playing) "❚❚" else "▶", fontSize = 16.sp, color = if (dark) Color.White else AccentGreen,
            modifier = Modifier.clip(CircleShape).clickable { InlineMedia.toggle(context, url) }.padding(horizontal = 12.dp, vertical = 8.dp)
                .semantics { contentDescription = if (InlineMedia.playing) "一時停止" else "再生" })
        Slider(
            value = dragging ?: if (dur > 0) (pos.toFloat() / dur).coerceIn(0f, 1f) else 0f,
            onValueChange = { dragging = it },
            onValueChangeFinished = { dragging?.let { InlineMedia.seekTo((it * dur).toLong()); pos = (it * dur).toLong() }; dragging = null },
            enabled = dur > 0,
            colors = SliderDefaults.colors(thumbColor = if (dark) Color.White else AccentGreen, activeTrackColor = if (dark) Color.White else AccentGreen,
                inactiveTrackColor = fg.copy(alpha = 0.3f)),
            modifier = Modifier.weight(1f),
        )
        Text(if (InlineMedia.buffering && dur == 0L) "…" else "${clock(pos)} / ${if (dur > 0) clock(dur) else "--:--"}",
            style = MaterialTheme.typography.labelSmall, color = fg.copy(alpha = 0.85f), modifier = Modifier.padding(end = 6.dp))
    }
}

private fun clock(ms: Long): String {
    val s = ms / 1000
    return if (s >= 3600) "%d:%02d:%02d".format(s / 3600, s / 60 % 60, s % 60) else "%d:%02d".format(s / 60, s % 60)
}
