package fm.backspace.bguru.chat

import android.content.ContentValues
import android.content.Context
import android.media.MediaScannerConnection
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/*
 * 🍻 アルバムをまとめて保存 (docs/offkai-spec.md「アルバムをまとめて保存」). The apps do not use the Web's zip:
 * they read the whole album (`next_after`) and save the photos one by one — Android into MediaStore's
 * `Pictures/B-guru/<B-guru オフ会 2026-10-26 題>/`, with the names the Web zip has inside
 * (`001_表示名_1930.jpg`, src/lib/offkai.ts albumZip). Nothing goes anywhere else.
 */

/** The names (pure: JVM tests). Same rules as src/lib/offkai.ts safeFilePart / albumZip. */
object OffkaiAlbumNames {
    const val TITLE_MAX = 30
    const val UPLOADER_MAX = 16
    private val TOKYO: ZoneId = ZoneId.of("Asia/Tokyo")
    private val DAY = DateTimeFormatter.ofPattern("yyyy-MM-dd").withZone(TOKYO)
    private val HHMM = DateTimeFormatter.ofPattern("HHmm").withZone(TOKYO)

    /** Control characters, `\ / : * ? " < > |` and Unicode format characters (Cf, e.g. U+202E that turns the name
     *  around) — JS `[\u0000-\u001f\u007f\\/:*?"<>|]|\p{Cf}`. */
    private val UNSAFE = Regex("[\\u0000-\\u001f\\u007f\\\\/:*?\"<>|]|\\p{Cf}")
    /** JS `\s` (and what `trim()` drops): Java's `\s` is ASCII only. */
    private const val WS = "\\t\\n\\u000B\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff"
    private val SPACES = Regex("[$WS]+")
    private val EDGES = Regex("^[$WS]+|[$WS]+$")

    /** ファイル名に使える形: unsafe characters dropped, spaces collapsed, at most [max] code points, no leading dots. */
    fun safePart(v: String, max: Int): String {
        val s = EDGES.replace(SPACES.replace(UNSAFE.replace(v, ""), " "), "")
        val cps = s.codePoints().limit(max.toLong()).toArray()
        return String(cps, 0, cps.size).trimStart('.')
    }

    /** 「B-guru オフ会 2026-10-26 題」 (the zip's name without `.zip`): the day it started, in Japan. */
    fun folder(title: String, startedAt: String): String {
        val day = runCatching { DAY.format(Instant.parse(startedAt)) }.getOrDefault("")
        val t = safePart(title, TITLE_MAX)
        return listOf("B-guru オフ会", day, t).filter { it.isNotEmpty() }.joinToString(" ")
    }

    /** 「001_表示名_1930.jpg」: [index] from 0, oldest first; at least 3 digits (more when [total] needs them);
     *  the uploader dropped when nothing is left of the name; 時分 in Japan; the original's extension, lower case. */
    fun fileName(index: Int, total: Int, uploader: String?, createdAt: String, url: String): String {
        val width = maxOf(3, total.toString().length)
        val who = safePart(uploader ?: "", UPLOADER_MAX)
        val hm = runCatching { HHMM.format(Instant.parse(createdAt)) }.getOrDefault("0000")
        return (index + 1).toString().padStart(width, '0') + (if (who.isNotEmpty()) "_$who" else "") + "_" + hm + extension(url)
    }

    /** Node's `path.extname(...).toLowerCase()` of the URL's last part (".jpg"; "" when none). */
    fun extension(url: String): String {
        val name = url.substringBefore('?').substringBefore('#').substringAfterLast('/')
        val dot = name.lastIndexOf('.')
        return if (dot <= 0) "" else name.substring(dot).lowercase(java.util.Locale.ROOT)
    }

    fun mimeType(fileName: String): String = when (extension(fileName)) {
        ".png" -> "image/png"
        ".webp" -> "image/webp"
        ".gif" -> "image/gif"
        ".heic" -> "image/heic"
        else -> "image/jpeg"
    }

    /** 「12 / 40」 */
    fun progress(done: Int, total: Int): String = "$done / $total"

    /** 「40 枚を保存しました」/「38 枚を保存、2 枚は失敗」 */
    fun result(saved: Int, failed: Int): String =
        if (failed == 0) "$saved 枚を保存しました" else "$saved 枚を保存、$failed 枚は失敗"

    /** Stopped with 中止. */
    fun stopped(saved: Int): String = "保存を中止しました（$saved 枚は保存済み）"
}

/** Downloads a photo and writes it into the gallery. Android 10+: MediaStore with RELATIVE_PATH (no permission,
 *  IS_PENDING while writing). Android 9: the public Pictures folder (WRITE_EXTERNAL_STORAGE, asked before). */
object OffkaiAlbumSaver {
    const val ROOT = "B-guru"

    /** Android 9 and older need the storage permission to write into Pictures. */
    val needsWritePermission get() = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q

    /** One photo: true when it is in the gallery. Cancelling aborts the download and drops a half-written file. */
    suspend fun save(context: Context, folder: String, name: String, url: String, takenAt: String): Boolean {
        val bytes = download(url) ?: return false
        val taken = runCatching { Instant.parse(takenAt).toEpochMilli() }.getOrNull()
        return withContext(Dispatchers.IO) {
            runCatching {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) writeMediaStore(context, folder, name, bytes, taken) else writeLegacy(context, folder, name, bytes)
            }.getOrDefault(false)
        }
    }

    private suspend fun download(url: String): ByteArray? {
        val abs = ApiClient.absolute(url) ?: return null
        val req = Request.Builder().url(abs).apply {
            // Only our own server (same scheme, host, port) ever gets the token (like ImageCache).
            val t = ImageCache.token
            if (t != null && abs.startsWith(Net.BASE + "/")) header("Authorization", "Bearer $t")
        }.build()
        return Net.http.newCall(req).await().use { r ->
            if (!r.isSuccessful) return@use null
            withContext(Dispatchers.IO) { r.body.bytes() }.takeIf { it.isNotEmpty() }
        }
    }

    @androidx.annotation.RequiresApi(Build.VERSION_CODES.Q)
    private fun writeMediaStore(context: Context, folder: String, name: String, bytes: ByteArray, taken: Long?): Boolean {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, name)
            put(MediaStore.Images.Media.MIME_TYPE, OffkaiAlbumNames.mimeType(name))
            put(MediaStore.Images.Media.RELATIVE_PATH, "${Environment.DIRECTORY_PICTURES}/$ROOT/$folder/")
            if (taken != null) put(MediaStore.Images.Media.DATE_TAKEN, taken)
            put(MediaStore.Images.Media.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), values) ?: return false
        try {
            (resolver.openOutputStream(uri) ?: throw IllegalStateException("no stream")).use { it.write(bytes) }
            resolver.update(uri, ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING, 0) }, null, null)
            return true
        } catch (e: Exception) {
            runCatching { resolver.delete(uri, null, null) } // no half-written entry left behind
            throw e
        }
    }

    /** Android 9: a plain file in Pictures/B-guru/<folder>/ (` (2)` when the name is taken), then scanned. */
    @Suppress("DEPRECATION")
    private fun writeLegacy(context: Context, folder: String, name: String, bytes: ByteArray): Boolean {
        val dir = File(File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), ROOT), folder)
        if (!dir.isDirectory && !dir.mkdirs()) return false
        var file = File(dir, name)
        var n = 2
        while (file.exists()) {
            file = File(dir, name.substringBeforeLast('.') + " ($n)" + OffkaiAlbumNames.extension(name))
            n++
        }
        try {
            file.writeBytes(bytes)
        } catch (e: Exception) {
            file.delete()
            throw e
        }
        MediaScannerConnection.scanFile(context, arrayOf(file.absolutePath), arrayOf(OffkaiAlbumNames.mimeType(name)), null)
        return true
    }
}
