package fm.backspace.bguru.chat

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.ImageBitmap
import io.livekit.android.AudioOptions
import io.livekit.android.LiveKit
import io.livekit.android.LiveKitOverrides
import io.livekit.android.RoomOptions
import io.livekit.android.events.DisconnectReason
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.participant.AudioPresets
import io.livekit.android.room.participant.AudioTrackPublishDefaults
import io.livekit.android.room.track.LocalAudioTrackOptions
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/*
 * 🍻 オフ会 (docs/offkai-spec.md, src/lib/offkai.ts). One at a time, site-wide: one phone at the place speaks
 * into its own LiveKit room (bguru-offkai-<id>, not the voice room), the others listen, and everyone adds
 * photos to the album, which stays after the end. Speaking is last-wins: whoever pressed 「🎙 現地から話す」
 * last is the speaker, and the server takes the mic permission away from the one before — this phone stops
 * its mic the moment it learns it is no longer the speaker (stream or LiveKit, whichever comes first).
 * Listening here leaves the voice room (never two rooms' sound at once); VoiceService keeps either going
 * with the screen off. Main thread.
 */

object OffkaiLogic {
    const val TITLE_MAX = 40
    const val CAPTION_MAX = 200
    const val MAX_PHOTOS = 4
    const val PHOTO_MAX_SIDE = 1280
    const val ARCHIVE_PAGE = 20

    fun isOpen(e: OffkaiEvent?): Boolean = e != null && e.endedAt == null

    /** A newer state of the same event (or another event): take it. Same version is taken too (a GET
     *  re-reads what the stream said, with the viewer's own can_end). */
    fun isNewer(old: OffkaiEvent?, new: OffkaiEvent): Boolean = old == null || old.id != new.id || new.version >= old.version

    /** 「1時間23分」「12分」「たった今」 since it started. */
    fun elapsed(startedAt: String, now: Instant = Instant.now()): String {
        val t = runCatching { Instant.parse(startedAt) }.getOrNull() ?: return ""
        val min = Duration.between(t, now).toMinutes().coerceAtLeast(0)
        return when {
            min < 1 -> "たった今"
            min < 60 -> "${min}分"
            else -> "${min / 60}時間${min % 60}分"
        }
    }

    private val DAY = DateTimeFormatter.ofPattern("M/d（E）", Locale.JAPANESE).withZone(ZoneId.systemDefault())

    /** The archive's date: 「10/24（金）」. */
    fun dateLabel(startedAt: String): String = runCatching { DAY.format(Instant.parse(startedAt)) }.getOrDefault("")

    /** The title, or 「◯◯のオフ会」 when it was started without one. */
    fun title(e: OffkaiEvent): String = e.title.trim().ifEmpty { "${e.startedBy.name?.takeIf { it.isNotBlank() } ?: "だれか"}のオフ会" }

    /** May I press 「終了」: the server said so (admins), or I started it. Not the speaker: anyone can become
     *  the speaker (後勝ち), so 「話す」 then 「終了」 must not end someone else's event (security review). */
    fun canEnd(e: OffkaiEvent?, me: String?, serverSaid: Boolean): Boolean {
        if (!isOpen(e)) return false
        if (serverSaid) return true
        if (me.isNullOrEmpty()) return false
        return e!!.startedBy.userId == me
    }

    /** My photo (the stream's copy has mine = false, so the uploader decides too). */
    fun isMine(p: OffkaiPhoto, me: String?): Boolean = p.mine || (!me.isNullOrEmpty() && p.uploader.userId == me)

    /** A photo into the album: once, in time order (ids grow with time). */
    fun insert(list: List<OffkaiPhoto>, p: OffkaiPhoto): List<OffkaiPhoto> =
        if (list.any { it.id == p.id }) list else (list + p).sortedBy { it.id }

    /** What a refused action says. */
    fun message(e: Exception, fallback: String): String = when (e) {
        is ApiError.Unauthorized -> "ログインし直してください"
        is ApiError.Http -> when {
            e.code == "busy" -> "ほかのオフ会が開催中です"
            e.code == "not_open" -> "開催中のオフ会はありません"
            e.code == "voice_unavailable" -> "音声は今使えません"
            e.status == 429 -> e.serverMessage ?: "少し待ってから試してください"
            else -> e.serverMessage ?: fallback
        }
        is ApiError.Transport -> "ネットワークにつながりません"
        else -> fallback
    }
}

/** [reader]: the chat's (shared with 「🔈 読み上げ」); [readerWanted]: the chat still reads without 🍻, so
 *  leaving the 🍻 audio must not stop it. */
class OffkaiStore(private val api: ApiClient, private val app: Context, private val reader: ChatReader, private val readerWanted: () -> Boolean) {
    enum class Phase { IDLE, CONNECTING, CONNECTED, RECONNECTING }

    var enabled by mutableStateOf(false); private set
    var canControl by mutableStateOf(false); private set
    var basePath = "/api/agent/offkai"; private set
    /** The 🍻 tab is chosen (the panel is above / beside the chat). */
    var open by mutableStateOf(false)
    /** Bumped by a notification tap: the phone pager shows the chat. */
    var revealTick by mutableIntStateOf(0); private set

    var current by mutableStateOf<OffkaiEvent?>(null); private set
    var listeners by mutableIntStateOf(0); private set
    /** The current event's photos, oldest first. */
    var photos by mutableStateOf<List<OffkaiPhoto>>(emptyList()); private set
    var archive by mutableStateOf<List<OffkaiEvent>>(emptyList()); private set
    var archiveMore by mutableStateOf(false); private set
    /** An ended event opened from the archive, and its photos. */
    var album by mutableStateOf<OffkaiEvent?>(null); private set
    var albumPhotos by mutableStateOf<List<OffkaiPhoto>>(emptyList()); private set
    var albumLoading by mutableStateOf(false); private set

    var phase by mutableStateOf(Phase.IDLE); private set
    /** My mic is going out (I am the speaker and publishing). */
    var micOn by mutableStateOf(false); private set
    var busy by mutableStateOf(false); private set
    var uploading by mutableIntStateOf(0); private set
    var notice by mutableStateOf<String?>(null)
    var myUserId by mutableStateOf<String?>(null); private set
    /** Demo uploads: their pictures (no server to fetch them from). */
    var localPictures by mutableStateOf<Map<Long, ImageBitmap>>(emptyMap()); private set

    /** 🔈 チャットを読み上げる: this phone's own switch (kept on the phone, on by default). */
    var readChat by mutableStateOf(app.getSharedPreferences(OffkaiReadAloud.PREFS, Context.MODE_PRIVATE).getBoolean(OffkaiReadAloud.PREF_KEY, true)); private set

    fun changeReadChat(on: Boolean) {
        readChat = on
        app.getSharedPreferences(OffkaiReadAloud.PREFS, Context.MODE_PRIVATE).edit().putBoolean(OffkaiReadAloud.PREF_KEY, on).apply()
        reader.reset()
        if (!on) stopReading()
    }

    /** New chat messages are read for 🍻: this phone is in the 🍻 audio (listening or speaking) and its switch is on. */
    val reading get() = readChat && running && listening

    /** 🍻 no longer wants reading: stop (mid-sentence, the queue dropped) unless the chat's 「🔈 読み上げ」 still does. */
    private fun stopReading() { if (!readerWanted()) reader.stop() }

    /** The GET's can_end for the current event (admins may end any). */
    private var serverCanEnd = false
    /** Who I am, from the chat (my own messages) when nothing here has said it yet. */
    var fallbackMe: (() -> String?)? = null

    val running get() = OffkaiLogic.isOpen(current)
    val listening get() = phase != Phase.IDLE
    val me get() = myUserId ?: fallbackMe?.invoke()
    val iAmSpeaker get() = running && me != null && current?.speaker?.userId == me
    val canEnd get() = canControl && OffkaiLogic.canEnd(current, me, serverCanEnd)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var room: Room? = null
    private var events: Job? = null
    /** Bumped by every connect and leave: an overtaken connect gives up. */
    private var attempt = 0
    var demo = false; private set

    fun configure(caps: Capabilities?) {
        if (demo) return
        enabled = caps?.offkaiEnabled == true
        canControl = caps?.canControlOffkai == true
        caps?.let { basePath = it.offkaiPath }
        if (enabled) scope.launch { reload() } else { open = false; stopListening() }
        if (enabled && pendingReveal) reveal()
        pendingReveal = false
    }

    /** Tapped before the capabilities arrived (cold start from the notification). */
    private var pendingReveal = false

    /** A notification tap / the demo: the chat on the 🍻 tab. */
    fun reveal() {
        if (!enabled) { pendingReveal = true; return }
        open = true
        revealTick++
        if (!demo) scope.launch { reload() }
    }

    // MARK: state

    /** The whole state again (tab opened, stream reconnected). */
    suspend fun reload() {
        if (!enabled || demo) return
        try {
            val s = api.offkaiState(basePath)
            if (!s.enabled) { enabled = false; open = false; stopListening(); return }
            listeners = s.listeners
            archive = s.archive
            archiveMore = s.archive.size >= OffkaiLogic.ARCHIVE_PAGE
            val c = s.current
            if (c != null) {
                serverCanEnd = c.canEnd
                take(c)
            } else {
                current?.let { ended(it, intoArchive = false) } // the list above has it already
                serverCanEnd = false
            }
        } catch (e: CancellationException) { throw e } catch (e: ApiError.Unauthorized) {
            notice = OffkaiLogic.message(e, "")
        } catch (_: Exception) { }
    }

    fun refresh() { scope.launch { reload() } }

    fun loadMoreArchive() {
        val last = archive.lastOrNull() ?: return
        if (!archiveMore || demo) return
        archiveMore = false
        scope.launch {
            try {
                val s = api.offkaiState(basePath, before = last.id)
                archive = archive + s.archive.filter { a -> archive.none { it.id == a.id } }
                archiveMore = s.archive.size >= OffkaiLogic.ARCHIVE_PAGE
            } catch (e: CancellationException) { throw e } catch (_: Exception) { archiveMore = true }
        }
    }

    private suspend fun allPhotos(id: Long): List<OffkaiPhoto> {
        val out = ArrayList<OffkaiPhoto>()
        var after: Long? = null
        repeat(20) { // at most 2000 photos (100 a page)
            val r = api.offkaiPhotos(basePath, id, after)
            out += r.photos
            r.photos.firstOrNull { it.mine }?.let { learnMe(it.uploader.userId) }
            after = r.nextAfter ?: return out
        }
        return out
    }

    private fun loadPhotos(id: Long) {
        scope.launch {
            try {
                val list = allPhotos(id)
                if (current?.id == id) photos = list.fold(photos.filter { p -> list.none { it.id == p.id } }) { acc, p -> OffkaiLogic.insert(acc, p) }
            } catch (e: CancellationException) { throw e } catch (_: Exception) { }
        }
    }

    /** An event from the stream / an answer / GET. Older versions of the one I have are dropped (a GET or an
     *  answer can be overtaken by the stream: someone else pressed 話す a moment later). */
    private fun take(e: OffkaiEvent) {
        val old = current
        if (old != null && !OffkaiLogic.isNewer(old, e)) return
        if (e.endedAt != null) {
            if (old?.id == e.id || old == null) ended(e) else archive = listOf(e) + archive.filterNot { it.id == e.id }
            return
        }
        val fresh = old?.id != e.id
        current = e
        if (fresh) {
            photos = emptyList()
            if (!demo) loadPhotos(e.id)
            if (old != null) stopListening() // another event's room
        }
        // Last wins: someone else speaks now — my mic stops at once (the server takes the permission too).
        if (micOn && e.speaker?.userId != me) {
            setMic(false)
            notice = "ほかの人が話し始めたので、マイクを止めました"
        }
    }

    private fun ended(e: OffkaiEvent, intoArchive: Boolean = true) {
        current = null
        serverCanEnd = false
        listeners = 0
        if (intoArchive) archive = listOf(e.copy(photoCount = maxOf(e.photoCount, photos.size), cover = e.cover ?: photos.firstOrNull()?.url)) +
            archive.filterNot { it.id == e.id }
        photos = emptyList()
        stopReading()
        stopListening()
    }

    private fun learnMe(id: String?) { if (!id.isNullOrEmpty()) myUserId = id }

    /** The stream's `event: offkai`. */
    fun onStreamEvent(data: String) {
        val d = runCatching { ApiJson.decodeFromString<OffkaiStreamData>(data) }.getOrNull() ?: return
        when (d.action) {
            "start", "update", "end" -> d.event?.let { take(it) }
            "photo" -> d.photo?.let { p ->
                if (d.eventId == null || d.eventId == current?.id) photos = OffkaiLogic.insert(photos, p)
                if (album?.id == d.eventId) albumPhotos = OffkaiLogic.insert(albumPhotos, p)
            }
            "photo_delete" -> d.photoId?.let { id ->
                photos = photos.filterNot { it.id == id }
                albumPhotos = albumPhotos.filterNot { it.id == id }
            }
            "listeners" -> d.listeners?.let { listeners = it }
        }
    }

    // MARK: actions

    fun start(title: String) {
        if (busy || !canControl) return
        val t = title.trim().take(OffkaiLogic.TITLE_MAX)
        notice = null
        if (demo) {
            take(OffkaiEvent(id = 9100 + archive.size + 1L, version = 1, title = t, startedBy = OffkaiPerson("me", "ドリキン"),
                startedAt = Instant.now().toString(), endsAt = Instant.now().plusSeconds(6 * 3600).toString()))
            return
        }
        busy = true
        scope.launch {
            try {
                api.offkaiStart(basePath, t)?.let { e -> learnMe(e.startedBy.userId); serverCanEnd = true; take(e) }
            } catch (e: CancellationException) { throw e } catch (e: Exception) {
                notice = OffkaiLogic.message(e, "始められませんでした")
                if (e is ApiError.Http && e.code == "busy") reload()
            } finally { busy = false }
        }
    }

    fun end() {
        if (busy || !canEnd) return
        notice = null
        if (demo) { current?.let { ended(it.copy(endedAt = Instant.now().toString())) }; return }
        busy = true
        scope.launch {
            try {
                api.offkaiEnd(basePath)?.let { take(it) }
            } catch (e: CancellationException) { throw e } catch (e: Exception) {
                notice = OffkaiLogic.message(e, "終了できませんでした")
            } finally { busy = false }
        }
    }

    /** 🔊 聞く: into the event's room, listening only. */
    fun listen() {
        if (!running || phase != Phase.IDLE) return
        notice = null
        enterRoom()
        if (demo) { phase = Phase.CONNECTED; return }
        phase = Phase.CONNECTING
        val mine = ++attempt
        scope.launch {
            try {
                val t = api.offkaiToken(basePath)
                if (mine != attempt) return@launch
                connect(t, mine, publish = false)
            } catch (e: CancellationException) { throw e } catch (e: Exception) {
                if (mine != attempt) return@launch
                if (BuildConfig.DEBUG) android.util.Log.d("BguruOffkai", "listen failed", e)
                teardown()
                notice = OffkaiLogic.message(e, "オフ会の音声につながりませんでした")
            }
        }
    }

    /** 止める (also: the voice room was joined, the event ended, signed out). */
    fun stopListening(reason: String? = null) {
        if (phase == Phase.IDLE && room == null && !micOn) return
        val wasSpeaker = micOn
        teardown()
        if (reason != null) notice = reason
        // Still the speaker on the server: say so, so the place is free for someone else at once.
        if (wasSpeaker && iAmSpeaker && !demo) scope.launch { runCatching { api.offkaiSpeak(basePath, false) }.getOrNull()?.event?.let { take(it) } }
    }

    /** 🎙 現地から話す (on) / 話すのをやめる (off). The caller has the RECORD_AUDIO permission for on. */
    fun speak(on: Boolean) {
        if (!running || busy || !canControl) return
        notice = null
        if (!on) setMic(false) // the mic stops before the server hears of it
        if (demo) {
            current = current?.let { c -> c.copy(version = c.version + 1, speaker = if (on) OffkaiSpeaker("me", "ドリキン", connected = true) else null) }
            if (on) { enterRoom(); phase = Phase.CONNECTED; micOn = true }
            return
        }
        busy = true
        scope.launch {
            try {
                val r = api.offkaiSpeak(basePath, on)
                // (Not who I am: someone may have pressed 話す right after me — the room's identity says it.)
                r.event?.let { take(it) }
                if (on) {
                    if (r.token.isEmpty()) { notice = "音声は今使えません"; return@launch }
                    if (!r.canSpeak) { notice = "ほかの人が先に話し始めました"; return@launch }
                    // Back into the room with the key that may publish, then the mic on.
                    if (room != null || phase != Phase.IDLE) teardown(keepService = true)
                    enterRoom()
                    phase = Phase.CONNECTING
                    val mine = ++attempt
                    connect(r, mine, publish = true)
                }
            } catch (e: CancellationException) { throw e } catch (e: Exception) {
                if (BuildConfig.DEBUG) android.util.Log.d("BguruOffkai", "speak($on) failed", e)
                if (on) { setMic(false); if (phase == Phase.CONNECTING) teardown() }
                notice = OffkaiLogic.message(e, if (on) "話せませんでした" else "うまくいきませんでした")
            } finally { busy = false }
        }
    }

    /** Photos from 📷 (JPEGs already resized to 1280 px with EXIF gone — ChatAttachments). */
    fun upload(list: List<ChatPhoto>, caption: String, restore: (List<ChatPhoto>) -> Unit) {
        if (list.isEmpty() || !running || !canControl) return
        val c = caption.trim().take(OffkaiLogic.CAPTION_MAX)
        notice = null
        if (demo) {
            var next = (photos.maxOfOrNull { it.id } ?: 9000L) + 1
            val added = list.map { ph ->
                val p = OffkaiPhoto(next++, "", OffkaiPerson("me", "ドリキン"), c, Instant.now().toString(), mine = true)
                localPictures = localPictures + (p.id to ph.preview)
                p
            }
            photos = added.fold(photos) { acc, p -> OffkaiLogic.insert(acc, p) }
            current = current?.let { it.copy(photoCount = it.photoCount + added.size) }
            return
        }
        uploading += list.size
        scope.launch {
            try {
                val added = api.offkaiUpload(basePath, list.take(OffkaiLogic.MAX_PHOTOS).map { it.jpeg }, c)
                added.firstOrNull()?.let { learnMe(it.uploader.userId) }
                photos = added.fold(photos) { acc, p -> OffkaiLogic.insert(acc.filterNot { it.id == p.id }, p) }
            } catch (e: CancellationException) { throw e } catch (e: Exception) {
                notice = OffkaiLogic.message(e, "写真を送れませんでした")
                restore(list)
            } finally { uploading -= list.size }
        }
    }

    fun deletePhoto(p: OffkaiPhoto) {
        val before = photos to albumPhotos
        photos = photos.filterNot { it.id == p.id }
        albumPhotos = albumPhotos.filterNot { it.id == p.id }
        if (demo) return
        scope.launch {
            try {
                api.offkaiDeletePhoto(basePath, p.id)
            } catch (e: CancellationException) { throw e } catch (e: Exception) {
                if (e is ApiError.Http && e.status == 404) return@launch // already gone
                photos = before.first; albumPhotos = before.second
                notice = OffkaiLogic.message(e, "消せませんでした")
            }
        }
    }

    fun openAlbum(e: OffkaiEvent) {
        album = e
        albumPhotos = emptyList()
        if (demo) { albumPhotos = demoAlbums[e.id].orEmpty(); return }
        albumLoading = true
        scope.launch {
            try {
                val list = allPhotos(e.id)
                if (album?.id == e.id) albumPhotos = list
            } catch (ex: CancellationException) { throw ex } catch (ex: Exception) {
                if (album?.id == e.id) notice = OffkaiLogic.message(ex, "アルバムを開けませんでした")
            } finally { if (album?.id == e.id) albumLoading = false }
        }
    }

    fun closeAlbum() { album = null; albumPhotos = emptyList(); albumLoading = false }

    fun close() {
        stopReading()
        stopListening()
        scope.cancel()
    }

    // MARK: the room (LiveKit)

    /** Before any sound: out of the voice room, the jukebox paused. */
    private fun enterRoom() {
        App.session(app).store?.voice?.leave()
        App.session(app).jukebox?.voiceStarted()
    }

    private suspend fun connect(t: OffkaiTokenReply, mine: Int, publish: Boolean) {
        // Media only ever goes over TLS (the server hands out wss://…/livekit).
        if (!t.url.startsWith("wss://") || t.token.isEmpty()) throw IllegalStateException("offkai voice url")
        val r = LiveKit.create(
            app,
            RoomOptions(
                audioTrackCaptureDefaults = LocalAudioTrackOptions(noiseSuppression = true, echoCancellation = true, autoGainControl = true),
                // Speech-quality Opus like the voice room; DTX off silence.
                audioTrackPublishDefaults = AudioTrackPublishDefaults(audioBitrate = AudioPresets.SPEECH.maxBitrate, dtx = true, red = false),
            ),
            LiveKitOverrides(audioOptions = AudioOptions()),
        )
        room = r
        events = scope.launch { r.events.collect { onEvent(r, it) } }
        try {
            r.connect(t.url, t.token)
        } catch (e: Exception) {
            if (room === r) { room = null; events?.cancel(); events = null }
            r.release()
            throw e
        }
        if (mine != attempt || room !== r) { r.disconnect(); r.release(); return }
        learnMe(r.localParticipant.identity?.value)
        phase = Phase.CONNECTED
        VoiceService.start(app, mic = false, title = VoiceService.TITLE_OFFKAI)
        if (publish && iAmSpeaker) setMic(true)
    }

    private fun setMic(on: Boolean) {
        if (demo) { micOn = on; return }
        val r = room
        if (!on) {
            if (!micOn) return
            micOn = false
            if (r != null) {
                scope.launch { runCatching { r.localParticipant.setMicrophoneEnabled(false) } }
                VoiceService.start(app, mic = false, title = VoiceService.TITLE_OFFKAI) // the notification says 聞いています again
            }
            return
        }
        if (r == null || micOn) return
        micOn = true
        scope.launch {
            try {
                // The service holds the "microphone" type before capture starts, or Android silences the mic
                // when the app leaves the screen (the place's phone goes in a pocket).
                VoiceService.start(app, mic = true, title = VoiceService.TITLE_OFFKAI_SPEAK)
                if (!r.localParticipant.setMicrophoneEnabled(true)) throw IllegalStateException("mic")
                // Overtaken while the mic was starting.
                if (!micOn || !iAmSpeaker) { micOn = false; r.localParticipant.setMicrophoneEnabled(false) }
            } catch (e: CancellationException) { throw e } catch (e: Exception) {
                if (BuildConfig.DEBUG) android.util.Log.d("BguruOffkai", "mic failed", e)
                micOn = false
                notice = "マイクを使えません（設定でマイクを許可してください）"
            }
        }
    }

    private fun onEvent(from: Room, e: RoomEvent) {
        if (room !== from) return
        when (e) {
            is RoomEvent.Reconnecting -> phase = Phase.RECONNECTING
            is RoomEvent.Reconnected -> if (phase != Phase.IDLE) phase = Phase.CONNECTED
            is RoomEvent.ParticipantPermissionsChanged -> {
                // The server took my publish permission (someone else speaks now): the mic is gone already.
                if (e.participant === from.localParticipant && e.newPermissions?.canPublish != true && micOn) {
                    micOn = false
                    notice = "ほかの人が話し始めたので、マイクを止めました"
                }
            }
            is RoomEvent.Disconnected -> {
                if (e.reason == DisconnectReason.CLIENT_INITIATED) return
                // (teardown, not stopListening: the speaker stays the speaker on the server.)
                teardown()
                notice = when {
                    // I joined on another device (same identity, e.g. 「スマホで続ける」): not a failure, no rejoin.
                    e.reason == DisconnectReason.DUPLICATE_IDENTITY -> VoiceHandoff.CONTINUED_ELSEWHERE
                    running -> "オフ会の音声が切れました"
                    else -> null
                }
            }
            else -> Unit
        }
    }

    private fun teardown(keepService: Boolean = false) {
        attempt++
        val r = room
        room = null
        events?.cancel()
        events = null
        if (r != null) { r.disconnect(); r.release() }
        phase = Phase.IDLE
        micOn = false
        if (!keepService) stopReading() // out of the audio (keepService: back in at once to speak)
        if (!keepService && !demo) VoiceService.stop(app)
    }

    // MARK: demo

    /** Demo: none on (the start form and the archive). */
    fun demoEndCurrent() { if (demo) current?.let { ended(it.copy(endedAt = Instant.now().toString())) } }

    private var demoAlbums: Map<Long, List<OffkaiPhoto>> = emptyMap()

    /** Offline: a running event with photos (`images` = this Mac's demo photo server, else drawn
     *  placeholders), two ended ones in the archive. */
    fun loadDemo(images: String?) {
        demo = true
        enabled = true
        canControl = true
        myUserId = "me"
        val now = Instant.now()
        fun ago(min: Long) = now.minusSeconds(min * 60).toString()
        fun pic(i: Int) = if (images != null) "$images/photo${(i % 4) + 1}.jpg" else ""
        val mazzo = OffkaiPerson("mazzo", "mazzo")
        val takuto = OffkaiPerson("takuto", "takuto")
        val me = OffkaiPerson("me", "ドリキン")
        current = OffkaiEvent(9101, version = 3, title = "渋谷 ハチ公前", startedBy = mazzo, startedAt = ago(83), endsAt = now.plusSeconds(277 * 60).toString(),
            speaker = OffkaiSpeaker("takuto", "takuto", connected = true), photoCount = 5, cover = pic(0))
        listeners = 7
        photos = listOf(
            OffkaiPhoto(9001, pic(0), mazzo, "乾杯！", ago(80)),
            OffkaiPhoto(9002, pic(1), takuto, "", ago(70)),
            OffkaiPhoto(9003, pic(2), me, "オンラインから参加中", ago(52), mine = true),
            OffkaiPhoto(9004, pic(3), mazzo, "", ago(31)),
            OffkaiPhoto(9005, pic(4), takuto, "二軒目", ago(6)),
        )
        archive = listOf(
            OffkaiEvent(9099, version = 9, title = "秋葉原", startedBy = takuto, startedAt = "2026-10-12T10:00:00Z", endsAt = "2026-10-12T16:00:00Z",
                endedAt = "2026-10-12T13:20:00Z", photoCount = 3, cover = pic(1)),
            OffkaiEvent(9098, version = 4, title = "", startedBy = me, startedAt = "2026-09-28T09:00:00Z", endsAt = "2026-09-28T15:00:00Z",
                endedAt = "2026-09-28T11:05:00Z", photoCount = 2, cover = pic(3)),
        )
        demoAlbums = mapOf(
            9099L to listOf(OffkaiPhoto(8001, pic(1), takuto, "ラジオ会館", "2026-10-12T10:20:00Z"),
                OffkaiPhoto(8002, pic(2), mazzo, "", "2026-10-12T11:00:00Z"), OffkaiPhoto(8003, pic(3), me, "", "2026-10-12T12:30:00Z", mine = true)),
            9098L to listOf(OffkaiPhoto(8101, pic(3), me, "", "2026-09-28T09:30:00Z", mine = true), OffkaiPhoto(8102, pic(0), mazzo, "", "2026-09-28T10:10:00Z")),
        )
    }
}
