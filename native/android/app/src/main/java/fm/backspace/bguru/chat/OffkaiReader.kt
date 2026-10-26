package fm.backspace.bguru.chat

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
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
    /** The chat's own 「🔈 読み上げ」 (every new message, 🍻 or not; off by default). */
    const val PREF_ALL_KEY = "readAll"

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

    /** The same person again within this long after the last message read here: the name is left out. */
    const val SAME_AUTHOR_MS = 60_000L

    /** 「〇〇さん、本文」 — 〇〇 is [callName]; URLs as 「リンク」, over 80 characters cut with 「、以下略」; photos only:
     *  「〇〇さんが写真を送りました」; no name: the body alone. [omitName] (the same person just now, [omitsName]):
     *  the body alone, photos only 「写真です」. Null: nothing to read. */
    fun speech(m: ChatMessage, omitName: Boolean = false): String? {
        val name = if (omitName) null else callName(m.authorName)
        val text = body(m.visibleBody)
        if (text.isEmpty()) {
            if (m.images.isEmpty()) return null
            return when {
                omitName -> "写真です"
                name != null -> "${name}が写真を送りました"
                else -> "写真が送られました"
            }
        }
        return if (name != null) "${name}、$text" else text
    }

    /** The message before (read here) was by the same author ([prevAuthor], started at [prevAt]) within 60 s. */
    fun omitsName(prevAuthor: String?, prevAt: Long, author: String?, now: Long): Boolean =
        !author.isNullOrEmpty() && author == prevAuthor && now - prevAt in 0..SAME_AUTHOR_MS

    private val BRACKETS = Regex("""（[^（）]*）|\([^()]*\)|【[^【】]*】|\[[^\[\]]*\]|「[^「」]*」|『[^『』]*』|〔[^〔〕]*〕""")
    private val SEPARATORS = Regex("""[\s\u3000／/|｜・:：@＠～〜]+""")
    private val HONORIFICS = listOf("さん", "様", "さま", "氏", "くん", "君", "ちゃん", "先生")

    /** What the name is read as, with 「さん」 (docs/offkai-spec.md「賢い読み方」 — the same 6 steps as Web / Swift):
     *  1. brackets and what is inside dropped; 2. a leading @ / ＠ dropped, split at the separators;
     *  3. the first part with a letter or digit; 4. over 8 characters → the first 6;
     *  5. nothing left → the whole name (spaces folded), first 6; 6. no 「さん」 after an honorific.
     *  Null: no name. */
    fun callName(raw: String?): String? {
        val whole = SPACES.replace(raw ?: "", " ").trim()
        if (whole.isEmpty()) return null
        val stripped = BRACKETS.replace(whole, "").trim().trimStart('@', '＠')
        var name = stripped.split(SEPARATORS).firstOrNull { part -> part.codePoints().anyMatch { Character.isLetterOrDigit(it) } }
        if (name != null && name.codePointCount(0, name.length) > 8) name = firstChars(name, 6)
        val call = if (name.isNullOrEmpty()) firstChars(whole, 6) else name
        return if (HONORIFICS.any { call.endsWith(it) }) call else "${call}さん"
    }

    private fun firstChars(s: String, n: Int): String =
        if (s.codePointCount(0, s.length) <= n) s else s.substring(0, s.offsetByCodePoints(0, n))

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

/** 端末の日本語の声 1 つ（JVM で試せるよう Voice から写した形）。quality・latency は Voice の定数（100〜500）。 */
data class TtsVoice(
    val name: String,
    /** Locale の言語（"ja"）。 */
    val language: String,
    val quality: Int,
    val latency: Int,
    val networkRequired: Boolean,
    /** features に KEY_FEATURE_NOT_INSTALLED（データがまだ入っていない）。 */
    val notInstalled: Boolean,
)

/** 声の選び方 (docs/offkai-spec.md「声の選び方」): 端末の日本語の声のうち、いちばん自然なもの。外へは何も送らない。
 *  pure: JVM-tested in OffkaiVoicesTest. */
object OffkaiVoices {
    /** 選んだ声の名前（"" = 自動）。端末ごと。 */
    const val PREF_KEY = "voice"
    const val SAMPLE = "みなさん、こんばんは。チャットを読み上げます。"
    const val INSTALL_HINT = "設定 › 音声出力（テキスト読み上げ）› Google の音声データで日本語を入れると自然になります"
    /** Voice.QUALITY_HIGH（VERY_HIGH は 500）。これ以上に ★。 */
    const val QUALITY_HIGH = 400

    /** おもちゃの声（Eloquence／ノベルティ）: 自動では選ばない（選択肢には出す）。 */
    private val NOVELTY = setOf("eddy", "flo", "grandma", "grandpa", "reed", "rocko", "sandy", "shelley", "bubbles", "boing", "jester", "whisper", "zarvox", "trinoids", "organ", "superstar", "wobble", "cellos", "bells", "albert")
    private val WORDS = Regex("""[^a-z]+""")

    fun isNovelty(name: String): Boolean {
        val n = name.lowercase()
        if (n.contains("bad news") || n.contains("badnews") || n.contains("good news") || n.contains("goodnews")) return true
        return n.split(WORDS).any { it in NOVELTY }
    }

    /** 選べる声: 日本語・端末内（ネット不要）・入っているもの。品質の高い順 → 遅れの小さい順 → 名前。 */
    fun choices(all: List<TtsVoice>): List<TtsVoice> =
        all.filter { (it.language == "ja" || it.language == "jpn") && !it.networkRequired && !it.notInstalled }
            .distinctBy { it.name }
            .sortedWith(compareByDescending<TtsVoice> { it.quality }.thenBy { it.latency }.thenBy { it.name })

    /** 自動: 選べる声のいちばん上（おもちゃの声は飛ばす）。null: 該当なし（エンジンの日本語の既定のまま）。 */
    fun auto(all: List<TtsVoice>): TtsVoice? = choices(all).firstOrNull { !isNovelty(it.name) }

    /** 使う声: 選んだ声 [saved] があればそれ、消えていたら（"" も）自動。 */
    fun pick(all: List<TtsVoice>, saved: String?): TtsVoice? {
        if (!saved.isNullOrEmpty()) choices(all).firstOrNull { it.name == saved }?.let { return it }
        return auto(all)
    }

    /** 選んだ声が今も使えるか（消えていたら一覧では「自動」に印）。 */
    fun isAvailable(all: List<TtsVoice>, saved: String?): Boolean =
        !saved.isNullOrEmpty() && choices(all).any { it.name == saved }

    /** 標準の声しか無い（または 1 つも無い）: 入れ方を一行で案内する。 */
    fun needsInstallHint(all: List<TtsVoice>): Boolean = choices(all).none { it.quality >= QUALITY_HIGH }

    /** 一覧の品質の印: 高品質・最高品質に ★。 */
    fun mark(v: TtsVoice): String = if (v.quality >= QUALITY_HIGH) "★" else ""
}

/** Android の Voice → [TtsVoice]。 */
fun Voice.toTtsVoice(): TtsVoice = TtsVoice(
    name = name,
    language = locale?.language.orEmpty(),
    quality = quality,
    latency = latency,
    networkRequired = isNetworkConnectionRequired,
    notInstalled = features?.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) == true,
)

/** [saved]（"" = 自動）の声を [t] に付ける。該当なし・失敗はエンジンの日本語の既定のまま。 */
fun applyVoice(t: TextToSpeech, saved: String?) {
    val voices = runCatching { t.voices?.toList() }.getOrNull() ?: return
    val name = OffkaiVoices.pick(voices.map { it.toTtsVoice() }, saved)?.name ?: return
    val v = voices.firstOrNull { it.name == name } ?: return
    runCatching { t.voice = v }
}

/**
 * The phone's text-to-speech, one message at a time — one per ChatStore, shared by the chat's 「🔈 読み上げ」
 * and 🍻's 「🔈 チャットを読み上げる」 (so a message is never read twice). Main thread. The engine starts with
 * the first message and is shut down by [stop] (nothing left that wants reading).
 *
 * Audio, chosen per utterance: in a call (🍻 or the voice room: MODE_IN_COMMUNICATION) USAGE_VOICE_COMMUNICATION,
 * otherwise USAGE_ASSISTANT (the media route — voice communication outside a call would go to the earpiece);
 * CONTENT_TYPE_SPEECH and no audio focus request either way. While in the 🍻 audio
 * LiveKit holds the phone in MODE_IN_COMMUNICATION, and in that mode Android's audio policy plays the
 * sonification strategy (USAGE_ASSISTANCE_SONIFICATION) as an attenuated in-call tone — too quiet to hear
 * across a table — and the media strategy can go to a different output than the call (e.g. not to a Bluetooth
 * headset in SCO). Voice-communication usage follows the same route and the same volume as the 🍻 sound the
 * member is already listening to, mixes with LiveKit's playout instead of replacing it, and is the echo
 * canceller's reference on most phones (so a speaking phone's mic picks up less of it). Not asking for audio
 * focus means LiveKit's call is never told to duck or pause.
 */
class ChatReader(private val app: Context, private val onUnavailable: (String) -> Unit) {
    private class Item(val message: ChatMessage, val at: Long)

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

    /** The last message read (for 「同じ人が続けたら名前を省く」): its author and when it started. */
    private var lastAuthor: String? = null
    private var lastAt = 0L

    /** A message to read (already passed [OffkaiReadAloud.shouldRead]); the words are made when its turn
     *  comes, so the name is left out only after what was really read. */
    fun enqueue(m: ChatMessage) {
        if (unavailable) return
        queue.addLast(Item(m, SystemClock.elapsedRealtime()))
        if (tts == null) start() else if (ready && !speaking) next()
    }

    /** Stops mid-sentence, drops what waits, shuts the engine down. */
    fun stop() {
        generation++
        queue.clear()
        speaking = false
        currentId = null
        lastAuthor = null
        ready = false
        val t = tts ?: return
        tts = null
        runCatching { t.stop() }
        runCatching { t.shutdown() }
    }

    /** 「🗣 読み上げの声」が変わった: 動いているエンジンに次の発言から付ける（止まっていれば次に起こすとき）。 */
    fun voiceChanged() {
        val t = tts ?: return
        if (ready) applyVoice(t, savedVoice())
    }

    private fun savedVoice(): String? =
        app.getSharedPreferences(OffkaiReadAloud.PREFS, Context.MODE_PRIVATE).getString(OffkaiVoices.PREF_KEY, "")

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
        // 声の選び方: 選んだ声（消えていたら自動 = 端末内のいちばん良い日本語の声）。
        applyVoice(t, savedVoice())
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
        val now = SystemClock.elapsedRealtime()
        val item = OffkaiReadAloud.nextFresh(queue, now) { it.at } ?: return
        val text = OffkaiReadAloud.speech(item.message, OffkaiReadAloud.omitsName(lastAuthor, lastAt, item.message.authorId, now))
        if (text == null) { main.post { next() }; return }
        lastAuthor = item.message.authorId
        lastAt = now
        val id = "offkai-$generation-${seq++}"
        speaking = true
        currentId = id
        val inCall = app.getSystemService(AudioManager::class.java)?.mode == AudioManager.MODE_IN_COMMUNICATION
        runCatching {
            t.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(if (inCall) AudioAttributes.USAGE_VOICE_COMMUNICATION else AudioAttributes.USAGE_ASSISTANT)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            )
        }
        if (t.speak(text, TextToSpeech.QUEUE_ADD, Bundle(), id) != TextToSpeech.SUCCESS) {
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
        }, OffkaiReadAloud.watchdogMs(text))
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
