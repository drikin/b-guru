package fm.backspace.bguru.chat

import android.content.Context
import android.media.AudioAttributes
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.util.Locale

/*
 * 🍻 チャットの読み上げ (docs/offkai-spec.md「チャットの読み上げ」). While this phone is in the 🍻 audio and its
 * own 「🔈 チャットを読み上げる」 is on, other members' new chat messages are read aloud on the device
 * (TextToSpeech, Japanese voice; nothing leaves the phone), one after another, so the people at the place
 * do not miss what the remote ones write.
 */

/** What is read and how (pure: JVM-tested in OffkaiReadAloudTest). */
object OffkaiReadAloud {
    /** Longer bodies are cut here and end with 「、以下略」. */
    const val MAX_CHARS = 80
    /** Waited this long for its turn: dropped unread (no endless reading of old talk). */
    const val STALE_MS = 120_000L
    const val PREFS = "offkai"
    const val PREF_KEY = "readChat"

    /** ASCII non-space only (same rule on every platform): Japanese right after a URL is still read. */
    private val URL = Regex("""https?://[!-~]+""", RegexOption.IGNORE_CASE)
    private val SPACES = Regex("""\s+""")

    /** A new message that arrived over the stream: someone else's own words.
     *  Not mine, not a notice (入退室), not a ☗ card or any other card kind, not one already on screen. */
    fun shouldRead(m: ChatMessage, alreadyShown: Boolean): Boolean {
        if (alreadyShown || m.isAuthor || m.id <= 0) return false
        val k = m.kind
        return k.isNullOrEmpty() // 🐶 ビーグル AI の回答（beagle_ai）は会員の発言でなく長いので読まない（iPhone・Mac・Web と同じ）
    }

    /** 「〇〇さん、本文」 — URLs as 「リンク」, over 80 characters cut with 「、以下略」; photos only:
     *  「〇〇さんが写真を送りました」; no name: the body alone. Null: nothing to read. */
    fun speech(m: ChatMessage): String? {
        val name = m.authorName?.trim()?.takeIf { it.isNotEmpty() }
        val text = body(m.visibleBody)
        if (text.isEmpty()) {
            if (m.images.isEmpty()) return null
            return if (name != null) "${name}さんが写真を送りました" else "写真が送られました"
        }
        return if (name != null) "${name}さん、$text" else text
    }

    /** The body as it is read: URLs → 「リンク」, whitespace folded, cut at [MAX_CHARS] (whole characters). */
    fun body(raw: String): String {
        val t = SPACES.replace(URL.replace(raw, "リンク"), " ").trim()
        if (t.codePointCount(0, t.length) <= MAX_CHARS) return t
        return t.substring(0, t.offsetByCodePoints(0, MAX_CHARS)).trimEnd() + "、以下略"
    }

    /** How long one utterance may take before it counts as done anyway (an engine that never says
     *  onDone — audio focus / route changes, a phone call — must not stick the queue). */
    fun watchdogMs(text: String): Long = text.codePointCount(0, text.length) * 200L + 5_000L

    fun isStale(queuedAt: Long, now: Long): Boolean = now - queuedAt >= STALE_MS

    /** The next item to read: stale ones at the head are dropped (removed from [queue]). */
    fun <T> nextFresh(queue: ArrayDeque<T>, now: Long, queuedAt: (T) -> Long): T? {
        while (queue.isNotEmpty()) {
            val head = queue.removeFirst()
            if (!isStale(queuedAt(head), now)) return head
        }
        return null
    }
}

/**
 * The phone's text-to-speech, one message at a time. Main thread. The engine starts with the first message
 * and is shut down by [stop] (left the audio, toggle off, the event ended).
 *
 * Audio: USAGE_VOICE_COMMUNICATION + CONTENT_TYPE_SPEECH, and no audio focus request. While in the 🍻 audio
 * LiveKit holds the phone in MODE_IN_COMMUNICATION, and in that mode Android's audio policy plays the
 * sonification strategy (USAGE_ASSISTANCE_SONIFICATION) as an attenuated in-call tone — too quiet to hear
 * across a table — and the media strategy can go to a different output than the call (e.g. not to a Bluetooth
 * headset in SCO). Voice-communication usage follows the same route and the same volume as the 🍻 sound the
 * member is already listening to, mixes with LiveKit's playout instead of replacing it, and is the echo
 * canceller's reference on most phones (so a speaking phone's mic picks up less of it). Not asking for audio
 * focus means LiveKit's call is never told to duck or pause.
 */
class OffkaiReader(private val app: Context, private val onUnavailable: (String) -> Unit) {
    private class Item(val text: String, val at: Long)

    private val main = Handler(Looper.getMainLooper())
    private val queue = ArrayDeque<Item>()
    private var tts: TextToSpeech? = null
    private var ready = false
    private var speaking = false
    /** Bumped by [stop]: callbacks of an old engine / utterance are ignored. */
    private var generation = 0
    private var seq = 0L
    private var complained = false
    /** No Japanese voice / no engine: not tried again until the switch is turned off and on ([reset]). */
    private var unavailable = false
    /** The utterance being read; callbacks and the watchdog of any other one are ignored. */
    private var currentId: String? = null

    fun enqueue(text: String) {
        if (unavailable) return
        queue.addLast(Item(text, SystemClock.elapsedRealtime()))
        if (tts == null) start() else if (ready && !speaking) next()
    }

    /** Stops mid-sentence, drops what waits, shuts the engine down. */
    fun stop() {
        generation++
        queue.clear()
        speaking = false
        currentId = null
        ready = false
        val t = tts ?: return
        tts = null
        runCatching { t.stop() }
        runCatching { t.shutdown() }
    }

    /** The switch was turned off or on: a missing voice may have been installed since — try again. */
    fun reset() {
        unavailable = false
        complained = false
    }

    private fun start() {
        val gen = generation
        var created: TextToSpeech? = null
        // onInit may come before the constructor returns: post it, so `created` is set.
        created = runCatching { TextToSpeech(app) { status -> main.post { onInit(created, gen, status) } } }.getOrNull()
        if (created == null) { fail(); return }
        tts = created
    }

    private fun onInit(t: TextToSpeech?, gen: Int, status: Int) {
        if (t == null || gen != generation || t !== tts) { runCatching { t?.shutdown() }; return }
        if (status != TextToSpeech.SUCCESS) { fail(); return }
        val lang = runCatching { t.setLanguage(Locale.JAPANESE) }.getOrDefault(TextToSpeech.LANG_NOT_SUPPORTED)
        if (lang == TextToSpeech.LANG_MISSING_DATA || lang == TextToSpeech.LANG_NOT_SUPPORTED) { fail(); return }
        t.setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build()
        )
        t.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {}
            override fun onDone(utteranceId: String?) = finished(utteranceId)
            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) = finished(utteranceId)
            override fun onError(utteranceId: String?, errorCode: Int) = finished(utteranceId)
            override fun onStop(utteranceId: String?, interrupted: Boolean) = finished(utteranceId)
        })
        ready = true
        next()
    }

    /** From the engine's thread. */
    private fun finished(id: String?) {
        main.post {
            if (id == null || id != currentId) return@post
            done()
        }
    }

    private fun next() {
        val t = tts ?: return
        if (!ready || speaking) return
        val item = OffkaiReadAloud.nextFresh(queue, SystemClock.elapsedRealtime()) { it.at } ?: return
        val id = "offkai-$generation-${seq++}"
        speaking = true
        currentId = id
        if (t.speak(item.text, TextToSpeech.QUEUE_ADD, Bundle(), id) != TextToSpeech.SUCCESS) {
            speaking = false
            currentId = null
            main.post { next() }
            return
        }
        // Watchdog: no onDone in time — stop it and go on (late callbacks of it are ignored).
        main.postDelayed({
            if (currentId != id || tts !== t) return@postDelayed
            runCatching { t.stop() }
            done()
        }, OffkaiReadAloud.watchdogMs(item.text))
    }

    private fun done() {
        currentId = null
        speaking = false
        next()
    }

    private fun fail() {
        stop()
        unavailable = true
        if (!complained) { complained = true; onUnavailable("この端末では日本語の読み上げを使えません") }
    }
}
