package fm.backspace.bguru.chat

import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import android.provider.OpenableColumns
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody
import okio.BufferedSink
import okio.source
import java.io.ByteArrayOutputStream
import kotlin.math.max

/** A photo in a draft: one already on the server (editing a post) or one picked on this phone. */
sealed interface DraftImage {
    data class Remote(val url: String) : DraftImage
    class Local(val bitmap: Bitmap) : DraftImage
}

/** A video or sound picked on this phone, streamed from its content URI when sent. */
class MediaFile(val context: Context, val uri: Uri, val name: String, val mime: String, val bytes: Long) {
    fun body(kind: String): RequestBody = object : RequestBody() {
        val type: MediaType = MediaRules.uploadType(kind, mime, name).toMediaType()
        override fun contentType() = type
        override fun contentLength() = if (bytes > 0) bytes else -1
        override fun writeTo(sink: BufferedSink) {
            val input = context.contentResolver.openInputStream(uri) ?: throw java.io.IOException("cannot open")
            input.source().use { sink.writeAll(it) }
        }
    }

    companion object {
        fun of(context: Context, uri: Uri): MediaFile {
            var name = "file"
            var size = -1L
            context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    c.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 }?.let { i -> c.getString(i)?.let { name = it } }
                    c.getColumnIndex(OpenableColumns.SIZE).takeIf { it >= 0 && !c.isNull(it) }?.let { i -> size = c.getLong(i) }
                }
            }
            val mime = context.contentResolver.getType(uri) ?: ""
            return MediaFile(context.applicationContext, uri, name, mime, size)
        }
    }
}

/** A poll being written: 3–10 answers, a deadline of 1/6/12/24 hours (the text is the question). */
data class PollDraft(val options: List<String> = listOf("", "", ""), val durationHours: Int = 24)

/** Text + photos (+ a video or a sound, a poll, a club), shared by a new post, a thread reply
 *  and editing a post (same as PostDraft in native/shared/ComposeSheet.swift). Photos are
 *  decoded at most 2048 px on the long side (ImageDecoder also applies the EXIF rotation) and
 *  re-encoded as JPEG, so location and other EXIF never leave the phone. */
class PostDraft(val maxImages: Int, val maxMediaMb: Int = 100) {
    /** The text with its cursor and IME composition (needed to tell a conversion's Enter apart). */
    var value by mutableStateOf(androidx.compose.ui.text.input.TextFieldValue(""))
    var text: String
        get() = value.text
        set(v) { value = androidx.compose.ui.text.input.TextFieldValue(v, androidx.compose.ui.text.TextRange(v.length)) }
    var images by mutableStateOf<List<DraftImage>>(emptyList()); private set
    /** A new video / sound picked here (a video and a sound never together — the web's rule). */
    var video by mutableStateOf<MediaFile?>(null); private set
    var audio by mutableStateOf<MediaFile?>(null); private set
    /** Editing: the post's sound and video as they are on the server. */
    var audioRemote by mutableStateOf<String?>(null); private set
    var videoRemote by mutableStateOf<String?>(null); private set
    var poll by mutableStateOf<PollDraft?>(null)
    /** The club chosen by hand (a key), or null = the AI sorts it. */
    var club by mutableStateOf<String?>(null)
    var sending by mutableStateOf(false); private set
    /** "whisper" while 「うなる」 is sending (its button shows the progress). */
    var sendingKind by mutableStateOf<String?>(null); private set
    /** Photos being decoded (a large original can take a moment). */
    var loading by mutableStateOf(0); private set
    var error by mutableStateOf<String?>(null)
    private var original: Post? = null

    val hasMedia get() = video != null || audio != null || audioRemote != null || videoRemote != null
    val canSend get() = !sending && loading == 0 &&
        (text.isNotBlank() || images.isNotEmpty() || video != null || audio != null || poll != null)
    val remaining get() = (maxImages - images.size).coerceAtLeast(0)
    /** A video or a sound may still be attached (only one of them per post). */
    val canAttachMedia get() = !hasMedia
    val isEmpty get() = text.isEmpty() && images.isEmpty() && video == null && audio == null && poll == null

    /** Photos and (from the Photo Picker) a video: photos are decoded, a video is checked and kept. */
    suspend fun add(context: Context, uris: List<Uri>) {
        var failed = 0
        val (videos, photos) = withContext(Dispatchers.IO) { uris.partition { MediaRules.isVideo(context.contentResolver.getType(it)) } }
        if (videos.isNotEmpty()) attachVideo(context, videos.first())
        if (photos.isEmpty()) return
        loading += photos.size
        val loaded = try { withContext(Dispatchers.IO) {
            photos.take(remaining).mapNotNull { uri ->
                runCatching { decode(context, uri) }
                    .onFailure { if (BuildConfig.DEBUG) android.util.Log.d("BguruDraft", "decode failed", it) }
                    .getOrNull().also { if (it == null) failed++ }
            }
        } } finally { loading -= photos.size }
        images = images + loaded.map { DraftImage.Local(it) }
        if (BuildConfig.DEBUG) android.util.Log.d("BguruDraft", "added ${loaded.size}, now ${images.size}")
        error = if (failed > 0) "画像を${failed}枚読み込めませんでした" else null
    }

    suspend fun attachVideo(context: Context, uri: Uri) {
        if (!canAttachMedia) { error = "動画と音声は同時に添付できません"; return }
        val f = withContext(Dispatchers.IO) { runCatching { MediaFile.of(context, uri) }.getOrNull() } ?: run { error = "動画を読み込めませんでした"; return }
        error = MediaRules.checkVideo(f.mime, f.name, f.bytes, maxMediaMb)
        if (error == null) video = f
    }

    suspend fun attachAudio(context: Context, uri: Uri) {
        if (!canAttachMedia) { error = "動画と音声は同時に添付できません"; return }
        val f = withContext(Dispatchers.IO) { runCatching { MediaFile.of(context, uri) }.getOrNull() } ?: run { error = "音声を読み込めませんでした"; return }
        error = MediaRules.checkAudio(f.mime, f.name, f.bytes, maxMediaMb)
        if (error == null) audio = f
    }

    fun removeVideo() { video = null }
    fun removeAudio() { audio = null; audioRemote = null }

    fun remove(i: Int) { images = images.filterIndexed { idx, _ -> idx != i } }

    /** Reorder: the photo at `i` one place earlier. */
    fun moveEarlier(i: Int) {
        if (i <= 0 || i >= images.size) return
        images = images.toMutableList().also { val x = it.removeAt(i); it.add(i - 1, x) }
    }

    /** Demo only: a sample attachment (no file behind it — the demo never uploads). */
    fun demoAttach(images: List<String> = emptyList(), audio: String? = null) {
        this.images = images.map { DraftImage.Remote(it) }
        audioRemote = audio
    }

    /** Start editing `post`: its text, photos and sound (a video stays as it is — the web's rule). */
    fun startEdit(post: Post) {
        original = post
        text = post.text
        images = post.images.map { DraftImage.Remote(it) }
        audioRemote = post.audioUrl
        videoRemote = post.videoUrl
        video = null; audio = null; poll = null; club = null
    }

    private suspend fun uploadImages(api: ApiClient): List<String> {
        val local = images.filterIsInstance<DraftImage.Local>()
        val urls = if (local.isEmpty()) emptyList() else {
            val jpegs = withContext(Dispatchers.Default) { local.map { jpeg(it.bitmap) } }
            api.upload(jpegs)
        }
        val it = urls.iterator()
        return images.mapNotNull { img -> when (img) { is DraftImage.Remote -> img.url; is DraftImage.Local -> if (it.hasNext()) it.next() else null } }
    }

    /** Upload what is attached, then publish. Returns the stored post, or null (error set).
     *  `demo`: nothing leaves the phone — a local post comes back. */
    suspend fun send(api: ApiClient, parentId: Long?, whisper: Boolean = false, demo: Boolean = false): Post? {
        if (!canSend) return null
        val p = poll?.takeIf { parentId == null }
        if (p != null) {
            PollRules.validate(text, p.options, p.durationHours)?.let { error = it; return null }
        }
        sending = true
        sendingKind = if (whisper) "whisper" else "post"
        error = null
        try {
            val post = if (demo) {
                kotlinx.coroutines.delay(300)
                Post(System.currentTimeMillis() % 1_000_000 + 100_000, authorId = "me", authorName = "ドリキン", isAuthor = true, parentId = parentId,
                    text = text.trim(), images = images.filterIsInstance<DraftImage.Remote>().map { it.url }, createdAt = java.time.Instant.now().toString(),
                    club = club, poll = p?.let { d -> PostPoll(text.trim(), java.time.Instant.now().plusSeconds(d.durationHours * 3600L).toString(), editable = true,
                        options = PollRules.cleaned(d.options).mapIndexed { i, l -> PostPoll.Option(i + 1L, l) }) })
            } else {
                val urls = uploadImages(api)
                val videoUrl = video?.let { api.uploadMedia("video", it.name, it.body("video")) }
                val audioUrl = audio?.let { api.uploadMedia("audio", it.name, it.body("audio")) }
                api.publish(text.trim(), urls, parentId, PublishExtra(
                    whisper = whisper && parentId != null, videoUrl = videoUrl, audioUrl = audioUrl,
                    poll = p?.let { PollInput(text.trim(), PollRules.cleaned(it.options), it.durationHours) },
                    club = club?.takeIf { parentId == null },
                ))
            }
            text = ""
            images = emptyList()
            video = null; audio = null; poll = null; club = null
            return post
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            error = PostActions.errorText(e, "投稿できませんでした")
        } finally {
            sending = false
            sendingKind = null
        }
        return null
    }

    /** Save an edit of the post given to [startEdit]. `textOnly` (a write key): the text alone.
     *  Returns the post as it is now, or null (error set). */
    suspend fun saveEdit(api: ApiClient, textOnly: Boolean, demo: Boolean = false): Post? {
        val post = original ?: return null
        if (text.isBlank() && images.isEmpty() && audioRemote == null && audio == null && videoRemote == null && post.poll == null) {
            error = "本文を入力してください"; return null
        }
        sending = true
        error = null
        try {
            if (demo) {
                kotlinx.coroutines.delay(300)
                return post.copy(text = text.trim(), images = images.filterIsInstance<DraftImage.Remote>().map { it.url }, audioUrl = if (textOnly) post.audioUrl else audioRemote, display = null)
            }
            if (textOnly) {
                api.editPost(post.id, text.trim(), null, AudioChange.Keep, textOnly = true)
                return post.copy(text = text.trim(), display = null)
            }
            val changedImages = images.any { it is DraftImage.Local } || images.map { (it as DraftImage.Remote).url } != post.images
            val urls = if (changedImages) uploadImages(api) else post.images
            val newAudio = audio?.let { api.uploadMedia("audio", it.name, it.body("audio")) }
            val change = when {
                newAudio != null -> AudioChange.Set(newAudio)
                audioRemote == null && post.audioUrl != null -> AudioChange.Remove
                else -> AudioChange.Keep
            }
            api.editPost(post.id, text.trim(), if (changedImages) urls else null, change, textOnly = false)
            return post.copy(text = text.trim(), images = urls, display = null,
                audioUrl = when (change) { is AudioChange.Set -> change.url; AudioChange.Remove -> null; AudioChange.Keep -> post.audioUrl })
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            error = PostActions.errorText(e, "編集に失敗しました")
        } finally {
            sending = false
        }
        return null
    }

    companion object {
        private const val MAX_SIDE = 2048

        fun decode(context: Context, uri: Uri): Bitmap {
            val source = ImageDecoder.createSource(context.contentResolver, uri)
            return ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
                val w = info.size.width
                val h = info.size.height
                val scale = minOf(1.0, MAX_SIDE.toDouble() / max(w, h))
                decoder.setTargetSize((w * scale).toInt().coerceAtLeast(1), (h * scale).toInt().coerceAtLeast(1))
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE // compress() needs a software bitmap
            }
        }

        fun jpeg(bitmap: Bitmap): ByteArray = ByteArrayOutputStream().use { out ->
            bitmap.compress(Bitmap.CompressFormat.JPEG, 82, out)
            out.toByteArray()
        }
    }
}
