package fm.backspace.bguru.chat

import android.content.ComponentName
import android.content.Context
import androidx.annotation.OptIn
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.extractor.mp3.Mp3Extractor
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.time.Instant
import java.time.ZoneId

/** One episode with what the screen needs worked out once (the list is ~1,170 long). */
@Immutable
class JbItem(val ep: JukeboxEpisode) {
    val id get() = ep.id
    private val local = runCatching { Instant.parse(ep.publishedAt).atZone(JST) }.getOrNull()
    val year: Int = local?.year ?: ep.publishedAt.take(4).toIntOrNull() ?: 0
    /** month * 31 + day, for "N 年前の今ごろ". */
    val monthDay: Int = local?.let { (it.monthValue - 1) * 31 + it.dayOfMonth } ?: 0
    val date: String = local?.let { "%d.%02d.%02d".format(it.year, it.monthValue, it.dayOfMonth) } ?: ep.publishedAt.take(10).replace('-', '.')
    val label: String = episodeLabel(ep)
    val color: Color = labelColor(year)
    val duration: String = ep.durationSec?.let { formatTime(it.toLong()) } ?: ""
    val mainSeries: Boolean = ep.series in MAIN_SERIES
    /** Search: title and description, lower-cased once. */
    val haystack: String = (ep.title + "\n" + ep.summary).lowercase()

    companion object {
        val JST: ZoneId = ZoneId.of("Asia/Tokyo")
        val MAIN_SERIES = listOf("本編", "BSM", "B-side", "DANBO-side", "TechnoEdge-side", "Z-side")
        /** Label colour per year (the prototype's HUE table), hsl(h 62% 42%). */
        private val HUE = mapOf(2014 to 4, 2015 to 28, 2016 to 46, 2017 to 88, 2018 to 150, 2019 to 178, 2020 to 200,
            2021 to 222, 2022 to 258, 2023 to 290, 2024 to 322, 2025 to 345, 2026 to 12)
        fun labelColor(year: Int) = Color.hsl((HUE[year] ?: 140).toFloat(), 0.62f, 0.42f)

        private val EP = Regex("""ep\s?(\d{1,4})""", RegexOption.IGNORE_CASE)
        private val HASH = Regex("""#\s?(\d{1,4})""")
        private val BSM = Regex("""BSM\s?(\d{1,4})""", RegexOption.IGNORE_CASE)

        /** "#313" / "ep666", or 特別回 when the episode has no number. */
        fun episodeLabel(ep: JukeboxEpisode): String {
            val isEp = EP.containsMatchIn(ep.title)
            val n = ep.number ?: (HASH.find(ep.title) ?: EP.find(ep.title) ?: BSM.find(ep.title))?.groupValues?.get(1)?.toIntOrNull()
            return when {
                n == null -> "特別回"
                isEp -> "ep$n"
                else -> "#" + n.toString().padStart(3, '0')
            }
        }
    }
}

fun formatTime(totalSec: Long): String {
    val s = totalSec.coerceAtLeast(0)
    val h = s / 3600; val m = s % 3600 / 60; val ss = s % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, ss) else "%d:%02d".format(m, ss)
}

/** Where an episode was left: seconds in, its length, and whether it was heard to the end. */
@Immutable
data class JbProgress(val pos: Int, val dur: Int, val done: Boolean) {
    val fraction: Float get() = if (done) 1f else if (dur > 0) (pos.toFloat() / dur).coerceIn(0f, 1f) else 0f
}

/** The one ExoPlayer of the process. The store drives it; JukeboxService wraps it in a
 *  MediaSession (notification, lock screen, Bluetooth / headset buttons). */
@OptIn(UnstableApi::class)
object JukeboxEngine {
    private var player: ExoPlayer? = null

    fun player(context: Context): ExoPlayer = player ?: build(context.applicationContext).also { player = it }

    private fun build(context: Context): ExoPlayer {
        // The audio URL goes podscribe → podtrac → art19 → CDN (http and https mixed).
        val http = DefaultHttpDataSource.Factory()
            .setAllowCrossProtocolRedirects(true)
            .setUserAgent(Net.USER_AGENT)
            .setConnectTimeoutMs(15_000)
            .setReadTimeoutMs(20_000)
        // MP3 with no seek table: seek by constant bitrate (128 kbps), so resuming
        // an hour in is one Range request, not a read from the start.
        val extractors = DefaultExtractorsFactory().setMp3ExtractorFlags(Mp3Extractor.FLAG_ENABLE_CONSTANT_BITRATE_SEEKING)
        return ExoPlayer.Builder(context)
            .setMediaSourceFactory(DefaultMediaSourceFactory(DefaultDataSource.Factory(context, http), extractors))
            .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_SPEECH).build(), true)
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .setSeekBackIncrementMs(15_000)
            .setSeekForwardIncrementMs(30_000)
            .build()
    }
}

/** The jukebox: the catalogue (cached on disk), the shelf's filters, and playback.
 *  Lives as long as the sign-in, so playing goes on across tabs and in the background
 *  (docs/jukebox-client-spec.md). `demoBase`: demo mode — fake episodes whose audio is
 *  a local test file; nothing is fetched from the server or the real audio hosts. */
class JukeboxStore(private val app: Context, private val api: ApiClient, private val demoBase: String? = null) {
    // MARK: catalogue
    var items by mutableStateOf<List<JbItem>>(emptyList()); private set
    var today by mutableStateOf<JukeboxToday?>(null); private set
    var hasLoaded by mutableStateOf(false); private set
    var failed by mutableStateOf(false); private set
    private var byId: Map<String, JbItem> = emptyMap()
    private var byUrl: Map<String, JbItem> = emptyMap()

    // MARK: shelf filters (all local)
    var query by mutableStateOf("")
    /** null = すべて. Starts at the newest year, like the prototype. */
    var year by mutableStateOf<Int?>(null)
    var series by mutableStateOf(ALL_SERIES)
    private var yearChosen = false
    val years: List<Int> by derivedStateOf { items.map { it.year }.distinct().sortedDescending() }
    val filtered: List<JbItem> by derivedStateOf {
        val q = query.trim().lowercase()
        val y = year
        val s = series
        items.filter { e ->
            (y == null || e.year == y) &&
                (s == ALL_SERIES || (if (s == OTHER_SERIES) !e.mainSeries else e.ep.series == s)) &&
                (q.isEmpty() || e.haystack.contains(q))
        }
    }

    fun chooseYear(y: Int?) { year = y; yearChosen = true }
    fun search(q: String) {
        query = q
        if (q.isNotEmpty()) year = null // search the whole shelf
    }

    // MARK: playback state
    var current by mutableStateOf<JbItem?>(null); private set
    /** Something was played in this run: the mini player shows (until closed with ×). */
    var active by mutableStateOf(false); private set
    /** The needle is down: playing, or about to (buffering). */
    var playing by mutableStateOf(false); private set
    var positionMs by mutableLongStateOf(0L); private set
    var durationMs by mutableLongStateOf(0L); private set
    var speed by mutableFloatStateOf(1f); private set
    /** Sleep timer: minutes (15/30/60) with its end time, or [SLEEP_END_OF_EPISODE]. */
    var sleepMinutes by mutableStateOf<Int?>(null); private set
    var sleepEndsAt by mutableLongStateOf(0L); private set
    /** Paused because the member went into the voice room: the mini player offers 続きを再生. */
    var pausedForVoice by mutableStateOf(false); private set
    var notice by mutableStateOf<String?>(null)
    /** Set by the notification / the mini player: MainScreen shows the jukebox tab. */
    var showTab by mutableStateOf(false)
    /** Bumped when the tab is shown that way: the screen scrolls back to the turntable. */
    var revealTick by mutableIntStateOf(0)
    val progress = mutableStateMapOf<String, JbProgress>()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val prefs = app.getSharedPreferences(if (demoBase != null) "jukebox_demo" else "jukebox", Context.MODE_PRIVATE)
    private val cacheFile = File(app.filesDir, "jukebox.json")
    private var fetchStarted = false
    private var ticker: Job? = null
    private var switchJob: Job? = null
    private var sleepJob: Job? = null
    private var lastSave = 0L
    private var retried = 0
    private var controller: ListenableFuture<MediaController>? = null
    private var attached = false
    /** Created on first use (not at sign-in): members who never open the jukebox pay nothing. */
    private val player: ExoPlayer
        get() = JukeboxEngine.player(app).also { if (!attached) { attached = true; it.addListener(listener) } }

    private val listener = object : Player.Listener {
        override fun onEvents(p: Player, events: Player.Events) {
            val ours = p.currentMediaItem?.mediaId == current?.id
            val now = ours && p.playWhenReady && (p.playbackState == Player.STATE_READY || p.playbackState == Player.STATE_BUFFERING)
            if (now != playing) {
                playing = now
                if (now) startTicker() else { stopTicker(); save() }
            }
            if (ours && p.duration != C.TIME_UNSET) durationMs = p.duration
            if (ours && events.contains(Player.EVENT_POSITION_DISCONTINUITY)) positionMs = p.currentPosition
            if (p.isPlaying) retried = 0
            if (ours && events.contains(Player.EVENT_PLAYBACK_STATE_CHANGED) && p.playbackState == Player.STATE_ENDED) {
                positionMs = durationMs
                save(ended = true)
                if (sleepMinutes == SLEEP_END_OF_EPISODE) setSleep(null)
            }
            if (events.contains(Player.EVENT_PLAYBACK_PARAMETERS_CHANGED)) speed = p.playbackParameters.speed
        }

        /** The signed URL behind the redirects expires (~24 h): start again from the
         *  original audio_url, at the saved position. Once; then tell the member. */
        override fun onPlayerError(error: PlaybackException) {
            val c = current ?: return
            val at = maxOf(player.currentPosition, positionMs, (progress[c.id]?.pos ?: 0) * 1000L)
            if (retried < 1) {
                retried++
                player.setMediaItem(mediaItem(c), at)
                player.prepare()
                player.play()
            } else {
                notice = "再生できませんでした（通信を確かめてください）"
                positionMs = at
            }
        }
    }

    init {
        prefs.all.forEach { (k, v) ->
            if (k.startsWith("p:") && v is String) parseProgress(v)?.let { progress[k.removePrefix("p:")] = it }
        }
        if (demoBase != null) applyDemo(demoCatalogue(demoBase))
        else scope.launch { readCache() } // the timeline's "ジュークボックスで聴く" works before the tab is opened
    }

    // MARK: loading

    /** The tab came on screen: show the cache at once, read the server once in the background. */
    fun open(path: String) {
        if (demoBase != null || fetchStarted) return
        fetchStarted = true
        scope.launch {
            if (!hasLoaded) readCache()
            try {
                val text = api.jukeboxText(path)
                val r = withContext(Dispatchers.Default) { ApiJson.decodeFromString<JukeboxResponse>(text) }
                if (r.episodes.isNotEmpty()) {
                    applyResponse(r)
                    withContext(Dispatchers.IO) { runCatching { cacheFile.writeText(text) } }
                }
                failed = false
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                if (BuildConfig.DEBUG) android.util.Log.d("BguruJukebox", "load failed", e)
                failed = items.isEmpty()
                fetchStarted = false // try again next time the tab opens
            }
            hasLoaded = true
        }
    }

    private suspend fun readCache() {
        if (items.isNotEmpty()) return
        val r = withContext(Dispatchers.IO) {
            runCatching { if (cacheFile.exists()) ApiJson.decodeFromString<JukeboxResponse>(cacheFile.readText()) else null }.getOrNull()
        } ?: return
        if (items.isEmpty() && r.episodes.isNotEmpty()) { applyResponse(r); hasLoaded = true }
    }

    private suspend fun applyResponse(r: JukeboxResponse) {
        val list = withContext(Dispatchers.Default) { r.episodes.map(::JbItem) }
        applyItems(list, r.today)
    }

    private fun applyDemo(r: Pair<List<JbItem>, JukeboxToday?>) { applyItems(r.first, r.second); hasLoaded = true }

    private fun applyItems(list: List<JbItem>, t: JukeboxToday?) {
        items = list
        today = t
        byId = list.associateBy { it.id }
        byUrl = list.associateBy { it.ep.audioUrl }
        if (!yearChosen && query.isEmpty()) year = list.firstOrNull()?.year
        // The episode from last time, paused (the mini player shows it).
        if (current == null) prefs.getString("current", null)?.let { byId[it] }?.let { c ->
            current = c
            positionMs = startPositionMs(c)
            durationMs = (c.ep.durationSec ?: 0) * 1000L
        } else current?.let { c -> byId[c.id]?.let { current = it } }
    }

    /** The timeline: a post's audio_url that is one of the episodes. */
    fun episodeForUrl(url: String?): JbItem? = if (url == null || items.isEmpty()) null else byUrl[url] // reads `items`: recomposes once loaded
    fun episode(id: String?): JbItem? = id?.let { byId[it] }

    /** "N 年前の今ごろ": the server's pick, or (before 7:00 / older servers) one from ±3 days, fixed for the day. */
    val anniversary: Pair<JbItem, Int>? by derivedStateOf {
        val list = items
        today?.let { t -> byId[t.id]?.let { return@derivedStateOf it to t.yearsAgo } }
        val now = Instant.now().atZone(JbItem.JST)
        val md = (now.monthValue - 1) * 31 + now.dayOfMonth
        val c = list.filter { kotlin.math.abs(it.monthDay - md) <= 3 && it.year in 1 until now.year }
        if (c.isEmpty()) null else c[java.util.Random(now.toLocalDate().toEpochDay()).nextInt(c.size)].let { it to now.year - it.year }
    }

    fun shuffle() { if (items.isNotEmpty()) play(items.random()) }

    // MARK: playback

    fun play(item: JbItem) {
        notice = null
        pausedForVoice = false
        if (current?.id == item.id && player.currentMediaItem?.mediaId == item.id && player.playbackState != Player.STATE_IDLE) {
            resume(); return
        }
        save()
        val wasPlaying = playing
        current = item
        prefs.edit().putString("current", item.id).apply()
        positionMs = startPositionMs(item)
        durationMs = (item.ep.durationSec ?: 0) * 1000L
        switchJob?.cancel()
        if (wasPlaying) {
            // The needle lifts, the record changes, the needle drops.
            player.pause()
            switchJob = scope.launch { delay(650); start(item) }
        } else start(item)
    }

    private fun start(item: JbItem, atMs: Long = startPositionMs(item)) {
        active = true
        ensureService()
        retried = 0
        player.setMediaItem(mediaItem(item), atMs)
        player.playbackParameters = PlaybackParameters(speed)
        player.prepare()
        player.play()
    }

    fun toggle() = if (playing) pause() else resume()

    fun resume() {
        val c = current ?: return
        notice = null
        pausedForVoice = false
        val p = player
        if (p.currentMediaItem?.mediaId != c.id || p.playbackState == Player.STATE_IDLE) {
            // Not loaded, stopped or failed: build it again from the original audio_url, at where it was.
            val done = progress[c.id]?.done == true && positionMs >= durationMs - 1000
            start(c, if (done) 0L else positionMs); return
        }
        active = true
        ensureService()
        if (p.playbackState == Player.STATE_ENDED) p.seekTo(0)
        p.play()
    }

    fun pause() {
        switchJob?.cancel()
        player.pause()
        save()
    }

    /** × on the mini player: stop, keep the place, remove the notification. */
    fun dismiss() {
        pause()
        player.stop()
        active = false
        pausedForVoice = false
        setSleep(null)
    }

    fun seekBy(deltaMs: Long) {
        val c = current ?: return
        if (player.currentMediaItem?.mediaId != c.id) { positionMs = (positionMs + deltaMs).coerceAtLeast(0); return }
        val to = (player.currentPosition + deltaMs).coerceIn(0, if (durationMs > 0) durationMs else Long.MAX_VALUE)
        player.seekTo(to)
        positionMs = to
    }

    fun seekTo(fraction: Float) {
        val c = current ?: return
        val len = durationMs.takeIf { it > 0 } ?: return
        val to = (len * fraction.coerceIn(0f, 1f)).toLong()
        positionMs = to
        if (player.currentMediaItem?.mediaId == c.id) player.seekTo(to)
        else { progress[c.id] = JbProgress((to / 1000).toInt(), (len / 1000).toInt(), false); save() }
    }

    fun cycleSpeed() {
        val i = SPEEDS.indexOfFirst { kotlin.math.abs(it - speed) < 0.01f }
        speed = SPEEDS[(i + 1) % SPEEDS.size]
        player.playbackParameters = PlaybackParameters(speed) // pitch stays (voices sound natural)
    }

    /** 15 / 30 / 60 minutes, [SLEEP_END_OF_EPISODE], or null (off). */
    fun setSleep(minutes: Int?) {
        sleepJob?.cancel()
        sleepMinutes = minutes
        sleepEndsAt = 0L
        if (minutes == null || minutes == SLEEP_END_OF_EPISODE) return
        sleepEndsAt = System.currentTimeMillis() + minutes * 60_000L
        sleepJob = scope.launch {
            delay(minutes * 60_000L)
            pause()
            sleepMinutes = null
            sleepEndsAt = 0L
        }
    }

    // MARK: voice room

    /** Going into the voice room (部室): stop the record (no auto-resume afterwards). */
    fun voiceStarted() {
        if (playing || switchJob?.isActive == true) {
            pause()
            pausedForVoice = true
        }
    }

    // MARK: internals

    private fun startPositionMs(item: JbItem): Long =
        progress[item.id]?.takeIf { !it.done }?.pos?.times(1000L) ?: 0L

    /** Saved every 10 s while playing and on pause; heard when under 30 s remain. */
    private fun save(ended: Boolean = false) {
        val c = current ?: return
        val p = player
        if (p.currentMediaItem?.mediaId != c.id) return
        val pos = (p.currentPosition / 1000).toInt()
        val dur = ((if (p.duration != C.TIME_UNSET) p.duration else (c.ep.durationSec ?: 0) * 1000L) / 1000).toInt()
        if (pos <= 0 && !ended && progress[c.id] == null) return
        val done = ended || (dur > 0 && dur - pos < 30)
        val pr = JbProgress(pos, dur, done)
        progress[c.id] = pr
        prefs.edit().putString("p:${c.id}", "${pr.pos},${pr.dur},${if (done) 1 else 0}").apply()
        lastSave = System.currentTimeMillis()
    }

    private fun startTicker() {
        ticker?.cancel()
        lastSave = System.currentTimeMillis()
        ticker = scope.launch {
            while (isActive) {
                val p = player
                positionMs = p.currentPosition
                if (p.duration != C.TIME_UNSET) durationMs = p.duration
                if (System.currentTimeMillis() - lastSave >= 10_000) save()
                delay(500)
            }
        }
    }

    private fun stopTicker() {
        ticker?.cancel(); ticker = null
        if (player.currentMediaItem?.mediaId == current?.id) positionMs = player.currentPosition
    }

    /** Binding a controller creates JukeboxService (and its session); Media3 then puts it in
     *  the foreground with the notification while playing. */
    private fun ensureService() {
        val f = controller
        if (f != null && (!f.isDone || runCatching { f.get().isConnected }.getOrDefault(false))) return
        f?.let { MediaController.releaseFuture(it) }
        controller = MediaController.Builder(app, SessionToken(app, ComponentName(app, JukeboxService::class.java))).buildAsync()
    }

    private fun mediaItem(item: JbItem): MediaItem = MediaItem.Builder()
        .setMediaId(item.id)
        .setUri(item.ep.audioUrl) // exactly as given (the redirects count the download)
        .setMediaMetadata(
            MediaMetadata.Builder()
                .setTitle(item.ep.title)
                .setArtist("backspace.fm")
                .setAlbumTitle("${item.label} ・ ${item.date}")
                .setArtworkData(JukeboxArt.png(item), MediaMetadata.PICTURE_TYPE_FRONT_COVER)
                .build()
        )
        .build()

    /** Signed out: stop and forget the player state (progress stays on this device). */
    fun stop() {
        scope.cancel()
        if (!attached) return
        save()
        player.removeListener(listener)
        player.stop()
        player.clearMediaItems()
        controller?.let { MediaController.releaseFuture(it) }
        controller = null
    }

    private fun parseProgress(v: String): JbProgress? {
        val p = v.split(',')
        if (p.size < 3) return null
        return JbProgress(p[0].toIntOrNull() ?: return null, p[1].toIntOrNull() ?: 0, p[2] == "1")
    }

    companion object {
        const val ALL_SERIES = "すべての系列"
        const val OTHER_SERIES = "その他"
        val SERIES_CHIPS = listOf(ALL_SERIES) + JbItem.MAIN_SERIES + OTHER_SERIES
        val SPEEDS = listOf(1f, 1.25f, 1.5f, 1.75f, 2f)
        const val SLEEP_END_OF_EPISODE = -1

        /** Debug only: a fake catalogue (a few hand-written episodes + filler to ~1,170 for
         *  scrolling) whose audio is ONE local test file (`--es demo_jukebox http://10.0.2.2:8098`).
         *  Never the real Art19 / podtrac URLs: playing those would count as downloads. */
        fun demoCatalogue(base: String): Pair<List<JbItem>, JukeboxToday?> {
            val audio = "${base.trimEnd('/')}/test.mp3"
            fun ep(i: Int, at: String, title: String, series: String = "本編", number: Int? = null, sec: Int? = 180, summary: String = "") =
                JukeboxEpisode("demo-$i", title, at, "$audio?ep=$i", sec, series, number, summary.ifEmpty { "デモ用の回です。音はテスト用の 440 Hz の音です。" })
            val handful = listOf(
                ep(1, "2026-10-12T09:00:00Z", "#666:Pixel 11 と散財の秋", number = 666, summary = "Pixel 11 が届いた話と、秋の散財計画。"),
                ep(2, "2026-10-05T09:00:00Z", "B-side ep120:WWDC の答え合わせ", "B-side", 120, summary = "WWDC で出たものを振り返る。"),
                ep(3, "2025-06-10T09:00:00Z", "#600:WWDC25 スペシャル", number = 600, summary = "WWDC25 の基調講演をみんなで見た回。"),
                ep(4, "2024-03-02T09:00:00Z", "DANBO-side #40:カメラ沼", "DANBO-side", 40),
                ep(5, "2023-11-11T09:00:00Z", "TechnoEdge-side #12:ガジェット大賞", "TechnoEdge-side", 12),
                ep(6, "2022-08-20T09:00:00Z", "Z-side #3:ゲストと夏の話", "Z-side", 3),
                ep(7, "2021-01-01T09:00:00Z", "新年特別回 2021", "Special-side", null),
                ep(8, "2019-10-20T09:00:00Z", "#313:Galaxy ＆ 樋口監督ドヤ vs. GoPro 8ドヤ", number = 313,
                    summary = "Pixel 4が発表されたわけだが、…（デモ）"),
                ep(9, "2016-04-01T09:00:00Z", "#120:エイプリルフールと iPhone SE", number = 120),
                ep(10, "2014-10-18T09:00:00Z", "#001:backspace.fm はじまりました", number = 1),
            )
            val filler = (11..1170).map { i ->
                val day = Instant.parse("2026-09-28T09:00:00Z").minusSeconds(i * 86_400L * 7 / 2)
                val s = when (i % 9) { 0 -> "B-side"; 3 -> "DANBO-side"; 6 -> "Z-side"; else -> "本編" }
                ep(i, day.toString(), "#${1170 - i}:テスト回 $i（スクロールの確認用）", s, 1170 - i)
            }
            val items = (handful + filler).sortedByDescending { it.publishedAt }.map(::JbItem)
            return items to JukeboxToday("demo-8", yearsAgo = 7, postId = 9002)
        }

        fun demoAudioUrl(base: String) = "${base.trimEnd('/')}/test.mp3?ep=8"
    }
}

/** Artwork for the notification / lock screen: a record with this episode's label. */
object JukeboxArt {
    fun png(item: JbItem, size: Int = 256): ByteArray {
        val bmp = android.graphics.Bitmap.createBitmap(size, size, android.graphics.Bitmap.Config.ARGB_8888)
        val c = android.graphics.Canvas(bmp)
        val p = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)
        val r = size / 2f
        p.color = 0xFF26201B.toInt(); c.drawRect(0f, 0f, size.toFloat(), size.toFloat(), p)
        p.color = 0xFF111111.toInt(); c.drawCircle(r, r, r * 0.92f, p)
        p.style = android.graphics.Paint.Style.STROKE; p.strokeWidth = 1f; p.color = 0xFF2A2A2A.toInt()
        var g = r * 0.4f
        while (g < r * 0.9f) { c.drawCircle(r, r, g, p); g += 4f }
        p.style = android.graphics.Paint.Style.FILL
        p.color = item.color.toArgb()
        c.drawCircle(r, r, r * 0.36f, p)
        p.color = android.graphics.Color.WHITE
        p.textAlign = android.graphics.Paint.Align.CENTER
        p.typeface = android.graphics.Typeface.create(android.graphics.Typeface.MONOSPACE, android.graphics.Typeface.BOLD)
        p.textSize = size * 0.1f
        c.drawText(item.label, r, r + p.textSize * 0.1f, p)
        p.typeface = android.graphics.Typeface.DEFAULT
        p.textSize = size * 0.05f
        c.drawText(item.year.toString(), r, r + size * 0.09f, p)
        p.color = 0xFF26201B.toInt(); c.drawCircle(r, r - size * 0.11f, size * 0.012f, p)
        val out = java.io.ByteArrayOutputStream()
        bmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out)
        bmp.recycle()
        return out.toByteArray()
    }
}
