package fm.backspace.bguru.chat

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioDeviceInfo
import android.media.AudioManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
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
import io.livekit.android.room.participant.Participant
import io.livekit.android.room.participant.ParticipantTrackPermission
import io.livekit.android.room.track.RemoteAudioTrack
import io.livekit.android.room.track.LocalAudioTrack
import io.livekit.android.room.track.LocalAudioTrackOptions
import io.livekit.android.room.track.Track
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import livekit.org.webrtc.AudioTrackSink
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/** The voice room (ボイスルーム) — the Android twin of native/shared/VoiceStore.swift.
 *  One room for the whole community, open while someone is in it. LiveKit carries the
 *  audio; our server only hands out a short-lived join token (POST /api/agent/voice/token)
 *  and tells everyone who is in the room (the stream's `voice` event). Main thread only.
 *
 *  You always enter muted — the mic turns on only when you unmute, and Android asks for
 *  the microphone permission the first time. Nothing is recorded. While you are in the
 *  room a foreground service (VoiceService) keeps the call going with the screen off. */
class VoiceStore(private val api: ApiClient, private val app: Context) {
    enum class Phase { IDLE, CONNECTING, CONNECTED, RECONNECTING }

    data class Member(
        val userId: String,
        val name: String,
        val avatar: String?,
        val speaking: Boolean,
        val muted: Boolean,
        val isMe: Boolean,
    )

    /** Server's view of the room (for people who have not joined). */
    var roomInfo by mutableStateOf<VoiceRoomInfo?>(null); private set
    var phase by mutableStateOf(Phase.IDLE); private set
    /** People in the room while I am in it (me first), from LiveKit itself. */
    var members by mutableStateOf<List<Member>>(emptyList()); private set
    var micOn by mutableStateOf(false); private set
    /** Turning the mic on/off is in progress. */
    var micBusy by mutableStateOf(false); private set
    /** What the mic picks up right now, 0…1, measured on this phone so it reacts instantly.
     *  Changes ~15 times a second: read it only in a draw / layer lambda (the ring), never
     *  in composition — [micActive] is the one to recompose on. */
    var micLevel by mutableFloatStateOf(0f); private set
    /** Above the noise floor: set only when it flips (on above 0.12, off below 0.10). */
    private var talking by mutableStateOf(false)
    /** My voice is going out (mic on and above the noise floor). */
    val micActive get() = micOn && talking
    /** Shown under the bar until the next action. */
    var notice by mutableStateOf<String?>(null)
    var enabled by mutableStateOf(false); private set
    var canJoin by mutableStateOf(false); private set
    var isAdmin by mutableStateOf(false); private set
    /** At most this many people with the mic on at once (server-provided). */
    var maxSpeakers by mutableIntStateOf(10); private set
    var myUserId by mutableStateOf<String?>(null); private set
    /** Someone the member chose to report (the bar shows the reason prompt). */
    var reportTarget by mutableStateOf<Member?>(null)

    val inRoom get() = phase != Phase.IDLE
    /** Only admins mute / remove / ban (the server enforces the same). */
    val canModerate get() = isAdmin

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var room: Room? = null
    private var events: Job? = null
    private var meter: MicMeter? = null
    private var meterTrack: LocalAudioTrack? = null
    /** Bumped by every join and leave, so an in-flight join that was overtaken by a
     *  leave (or a newer join) gives up instead of connecting. */
    private var attempt = 0

    // MARK: club room (ルーム) proximity — set by RoomStore while the room is on for this member.
    // With both unset (room disabled) nothing here changes the plain voice room.

    /** How loud each remote participant (identity = user_id) is for me, 0…1. */
    var proximity: ((String) -> Double)? = null
    /** Who may receive my microphone (identities). The meeting table's privacy rests on this. */
    var allowedListeners: (() -> Set<String>)? = null
    /** The room decides who may talk (server limits), not the plain room's speaker cap. */
    val roomMode get() = proximity != null
    private var sentAllowed: Set<String>? = null
    private var permJob: Job? = null

    /** The room changed (someone moved, came, left, …): volumes now, permissions batched. */
    fun proximityChanged() {
        if (room == null || !roomMode) return
        applyVolumes()
        if (permJob?.isActive != true) permJob = scope.launch {
            delay(300)
            sendPermissions(force = false)
        }
    }

    private fun applyVolumes() {
        val r = room ?: return
        val f = proximity ?: return
        for (p in r.remoteParticipants.values) {
            val id = p.identity?.value ?: continue
            val v = f(id).coerceIn(0.0, 1.0)
            for ((_, track) in p.audioTrackPublications) (track as? RemoteAudioTrack)?.setVolume(v)
        }
    }

    /** Only the people allowed to hear me may subscribe to my mic track. Sent when the set
     *  changes, and always right after connecting (before the mic can be turned on). */
    private fun sendPermissions(force: Boolean) {
        val r = room ?: return
        val f = allowedListeners ?: return
        val ids = f()
        if (!force && ids == sentAllowed) return
        try {
            r.localParticipant.setTrackSubscriptionPermissions(
                false,
                ids.map { ParticipantTrackPermission(participantIdentity = it, allTracksAllowed = true) },
            )
            sentAllowed = ids
        } catch (e: Exception) {
            if (BuildConfig.DEBUG) android.util.Log.d("BguruVoice", "track permissions failed", e)
            sentAllowed = null
        }
    }

    /** Debug builds only: a LiveKit server and token to join directly (demo mode, no B-guru API). */
    private var dev: Pair<String, String>? = null

    fun devDirect(url: String, token: String) {
        if (!BuildConfig.DEMO) return
        dev = url to token
        enabled = true
        canJoin = true
    }

    fun configure(caps: Capabilities?) {
        if (dev != null) return
        enabled = caps?.voiceEnabled ?: false
        canJoin = caps?.canJoinVoice ?: false
        isAdmin = caps?.isVoiceAdmin ?: false
        maxSpeakers = caps?.voiceMaxSpeakers ?: 10
        if (enabled) scope.launch { loadState() }
    }

    suspend fun loadState() {
        val s = runCatching { api.voiceState() }.getOrNull() ?: return
        enabled = s.enabled
        roomInfo = s.room
    }

    /** Stream `voice` event. */
    fun apply(info: VoiceRoomInfo) {
        roomInfo = info
        if (inRoom) refreshMembers()
    }

    val hasMicPermission: Boolean
        get() = ContextCompat.checkSelfPermission(app, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    /** A Bluetooth headset is connected — routing the call to it needs BLUETOOTH_CONNECT (Android 12+). */
    val bluetoothAudioConnected: Boolean
        get() {
            val am = app.getSystemService(AudioManager::class.java) ?: return false
            return am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any {
                it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || it.type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP ||
                    it.type == AudioDeviceInfo.TYPE_BLE_HEADSET
            }
        }

    // MARK: join / leave

    fun join() {
        if (phase != Phase.IDLE || !canJoin) return
        notice = null
        // The jukebox stops while you are in the room (the mini player offers 続きを再生 afterwards).
        App.session(app).jukebox?.voiceStarted()
        // 🍻 オフ会 stops too: never two rooms' sound at once.
        App.session(app).store?.offkai?.stopListening("ボイスルームに入ったので、オフ会の音を止めました")
        phase = Phase.CONNECTING
        val mine = ++attempt
        scope.launch {
            try {
                dev?.let { (url, token) -> connectRetrying(url, token, mine); return@launch }
                val t = api.voiceToken()
                // Left (or left and rejoined) while the token was on its way.
                if (mine != attempt || phase != Phase.CONNECTING) return@launch
                // Media only ever goes over TLS (the server hands out wss://…/livekit).
                if (!t.url.startsWith("wss://")) throw IllegalStateException("voice url is not wss")
                myUserId = t.identity.ifEmpty { null }
                connectRetrying(t.url, t.token, mine)
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiError) {
                if (mine != attempt) return@launch
                teardown()
                notice = message(e)
            } catch (e: Exception) {
                if (mine != attempt) return@launch
                if (BuildConfig.DEBUG) android.util.Log.d("BguruVoice", "connect failed", e)
                teardown()
                notice = "ボイスルームにつながりませんでした"
            }
        }
    }

    /** One retry: right after the app was killed, the server may still hold our previous
     *  connection (same identity) for a few seconds, and the first attempt can fail
     *  while it replaces it. */
    private suspend fun connectRetrying(url: String, token: String, mine: Int) {
        try {
            connect(url, token, mine)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (mine != attempt) return
            if (BuildConfig.DEBUG) android.util.Log.d("BguruVoice", "first connect failed, retrying", e)
            dropRoom()
            connect(url, token, mine)
        }
    }

    private suspend fun connect(url: String, token: String, mine: Int) {
        val r = LiveKit.create(
            app,
            RoomOptions(
                audioTrackCaptureDefaults = LocalAudioTrackOptions(noiseSuppression = true, echoCancellation = true, autoGainControl = true),
                // Speech-quality Opus, nothing sent during silence (DTX), no redundant copy
                // (RED doubles the bytes) — the server is shared and up to 100 listen.
                audioTrackPublishDefaults = AudioTrackPublishDefaults(audioBitrate = AudioPresets.SPEECH.maxBitrate, dtx = true, red = false),
            ),
            LiveKitOverrides(audioOptions = AudioOptions()),
        )
        room = r
        events = scope.launch { r.events.collect { onEvent(r, it) } }
        r.connect(url, token)
        // Left while connecting: this room is no longer ours.
        if (mine != attempt || room !== r) {
            r.disconnect()
            r.release()
            return
        }
        if (myUserId == null) myUserId = r.localParticipant.identity?.value
        micOn = false
        // Room mode: restrict who receives my mic before it can ever be published.
        if (roomMode) {
            sendPermissions(force = true)
            applyVolumes()
        }
        phase = Phase.CONNECTED
        VoiceService.start(app, mic = false)
        refreshMembers()
    }

    fun leave(reason: String? = null) {
        if (phase == Phase.IDLE && room == null) return
        teardown()
        if (reason != null) notice = reason
    }

    /** Signed out: hang up and stop for good. */
    fun close() {
        leave()
        scope.cancel()
    }

    /** The first unmute starts the mic and publishes the track, which takes a second or
     *  two. The button flips at once (optimistic) and ignores taps until that finishes.
     *  The caller has already got the RECORD_AUDIO permission. */
    fun setMic(on: Boolean) {
        val r = room ?: return
        if ((phase != Phase.CONNECTED && phase != Phase.RECONNECTING) || micBusy) return
        if (on && !roomMode && members.count { !it.isMe && !it.muted } >= maxSpeakers) {
            notice = "話せるのは同時に $maxSpeakers 人までです。誰かがミュートするまでお待ちください"
            return
        }
        if (on && !hasMicPermission) {
            notice = "マイクを使えません（設定でマイクを許可してください）"
            return
        }
        micBusy = true
        micOn = on
        notice = null
        scope.launch {
            try {
                // The service must hold the "microphone" type before capture starts, or
                // Android silences the mic as soon as the app leaves the screen.
                if (on) VoiceService.start(app, mic = true)
                val ok = r.localParticipant.setMicrophoneEnabled(on)
                if (!ok) throw IllegalStateException("setMicrophoneEnabled($on) failed")
                setMeter(r, on)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (BuildConfig.DEBUG) android.util.Log.d("BguruVoice", "setMic($on) failed", e)
                micOn = r.localParticipant.isMicrophoneEnabled
                notice = if (on) "マイクを使えません（設定でマイクを許可してください）" else null
            } finally {
                micBusy = false
            }
            refreshMembers()
        }
    }

    fun report(userId: String, reason: String) {
        scope.launch {
            notice = try {
                api.voiceReport(userId, reason)
                "管理者に通報しました"
            } catch (e: ApiError) {
                message(e)
            }
        }
    }

    fun forceMute(userId: String) {
        scope.launch {
            notice = try {
                if (api.voiceMute(userId)) "ミュートしました" else "マイクはオフでした"
            } catch (e: ApiError) {
                message(e)
            }
        }
    }

    fun kick(userId: String, ban: Boolean = false) {
        scope.launch {
            notice = try {
                api.voiceKick(userId, ban)
                if (ban) "退出させ、入室禁止にしました" else "退出させました"
            } catch (e: ApiError) {
                message(e)
            }
        }
    }

    private fun dropRoom() {
        val r = room
        room = null
        events?.cancel()
        events = null
        permJob?.cancel()
        permJob = null
        sentAllowed = null
        meterTrack?.let { t -> meter?.let(t::removeSink) }
        meter = null
        meterTrack = null
        micLevel = 0f
        talking = false
        if (r != null) {
            r.disconnect()
            r.release()
        }
    }

    private fun teardown() {
        attempt++
        dropRoom()
        phase = Phase.IDLE
        micOn = false
        micBusy = false
        members = emptyList()
        VoiceService.stop(app)
    }

    private fun setMeter(r: Room, on: Boolean) {
        if (on && meter == null) {
            val track = r.localParticipant.getTrackPublication(Track.Source.MICROPHONE)?.track as? LocalAudioTrack ?: return
            val m = MicMeter { level ->
                scope.launch {
                    if (meter == null) return@launch
                    // Nobody sees it in the background: no state writes (the first one back shows the level).
                    if (!ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) return@launch
                    // Rise fast, fall slowly, so the indicator does not flicker between words.
                    val next = if (level > micLevel) level else max(level, micLevel * 0.7f)
                    micLevel = next
                    if (talking) { if (next < 0.10f) talking = false } else if (next > 0.12f) talking = true
                }
            }
            track.addSink(m)
            meter = m
            meterTrack = track
        } else if (!on) {
            meterTrack?.let { t -> meter?.let(t::removeSink) }
            meter = null
            meterTrack = null
            micLevel = 0f
            talking = false
        }
    }

    // MARK: LiveKit events

    private fun onEvent(from: Room, e: RoomEvent) {
        val r = room
        if (r == null || r !== from) return // late event from an earlier room
        when (e) {
            is RoomEvent.Reconnecting -> phase = Phase.RECONNECTING
            is RoomEvent.Reconnected -> {
                if (phase != Phase.IDLE) phase = Phase.CONNECTED
                if (roomMode) sendPermissions(force = true)
            }
            is RoomEvent.Disconnected -> {
                if (BuildConfig.DEBUG) android.util.Log.d("BguruVoice", "disconnected: ${e.reason}", e.error)
                // We hung up ourselves (leave) — nothing to tell.
                if (e.reason == DisconnectReason.CLIENT_INITIATED) return
                notice = when (e.reason) {
                    DisconnectReason.PARTICIPANT_REMOVED -> "ボイスルームから退出させられました"
                    // I joined on another device (same identity, e.g. 「スマホで続ける」): not a failure, no rejoin.
                    DisconnectReason.DUPLICATE_IDENTITY -> VoiceHandoff.CONTINUED_ELSEWHERE
                    else -> "ボイスルームの接続が切れました"
                }
                teardown()
                return
            }
            else -> Unit
        }
        // An admin turned my mic off from the server: follow it.
        if (micOn && !micBusy && phase == Phase.CONNECTED && !r.localParticipant.isMicrophoneEnabled) {
            micOn = false
            setMeter(r, false)
            notice = "マイクがオフにされました（管理者の操作か、話せる人数の上限のため）"
        }
        refreshMembers()
        // A newly subscribed track starts at full volume: set it for where they stand.
        if (roomMode) applyVolumes()
        // Participant state (mic on/off, subscribed track) settles a moment after the
        // event itself — read it again once it has, so a face never stays stale.
        settle?.cancel()
        settle = scope.launch {
            delay(400)
            if (room === r) {
                refreshMembers()
                if (roomMode) applyVolumes()
            }
        }
    }

    private var settle: Job? = null

    private fun refreshMembers() {
        val r = room ?: run { members = emptyList(); return }
        val known = roomInfo?.participants.orEmpty().associateBy { it.userId }
        fun member(p: Participant, isMe: Boolean): Member? {
            val id = p.identity?.value ?: return null
            val info = known[id]
            return Member(
                userId = id,
                name = p.name?.takeIf { it.isNotEmpty() } ?: info?.name ?: "?",
                avatar = info?.avatar,
                // My own talking shows on the mic button, not as a ring on my face.
                speaking = !isMe && p.isSpeaking,
                muted = !p.isMicrophoneEnabled,
                isMe = isMe,
            )
        }
        val me = member(r.localParticipant, isMe = true)
        // Talking first, then mics on, then listeners — the bar only shows the first few.
        val others = r.remoteParticipants.values.mapNotNull { member(it, isMe = false) }
            .sortedWith(compareBy<Member>({ !it.speaking }, { it.muted }, { it.name }))
        members = listOfNotNull(me) + others
    }

    private fun message(e: ApiError): String = when (e) {
        is ApiError.Unauthorized -> "ログインし直してください"
        is ApiError.Http -> when {
            e.code == "membership_ended" -> "BSM 会員資格が確認できません"
            e.status == 429 -> "少し待ってから試してください"
            else -> e.serverMessage ?: "ボイスルームに入れません"
        }
        is ApiError.Transport -> "ネットワークにつながりません"
    }
}

/** Turns the mic's buffers into a 0…1 level (about 15 updates a second). Called on the
 *  audio thread, so it only does arithmetic and hands the number off. */
private class MicMeter(private val onLevel: (Float) -> Unit) : AudioTrackSink {
    @Volatile private var lastEmit = 0L

    override fun onData(
        audioData: ByteBuffer, bitsPerSample: Int, sampleRate: Int,
        numberOfChannels: Int, numberOfFrames: Int, absoluteCaptureTimestampMs: Long,
    ) {
        val now = System.nanoTime()
        if (now - lastEmit < 66_000_000L) return
        lastEmit = now
        if (bitsPerSample != 16) return
        val samples = audioData.duplicate().order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
        val n = samples.remaining()
        if (n <= 0) return
        var sum = 0.0
        for (i in 0 until n) {
            val v = samples.get(i) / 32768.0
            sum += v * v
        }
        val rms = sqrt(sum / n)
        val db = 20 * log10(max(rms, 1e-6))
        // -50 dBFS (room noise) → 0, -10 dBFS (close, loud speech) → 1.
        onLevel(min(max(((db + 50) / 40).toFloat(), 0f), 1f))
    }
}
