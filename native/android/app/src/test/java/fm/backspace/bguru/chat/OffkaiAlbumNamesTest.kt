package fm.backspace.bguru.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 🍻 ⬇ まとめて保存: the same names as the Web zip (src/lib/offkai.ts safeFilePart / albumZip), the messages,
 *  and `can_download` from the album's JSON. */
class OffkaiAlbumNamesTest {
    @Test fun fileNameLikeTheZip() {
        // 19:30 in Japan (10:30Z), oldest first from 001, the extension lower case.
        assertEquals("001_mazzo_1930.jpg", OffkaiAlbumNames.fileName(0, 40, "mazzo", "2026-10-26T10:30:00Z", "/api/media/offkai-abc.JPG"))
        assertEquals("040_ドリキン_0005.png", OffkaiAlbumNames.fileName(39, 40, "ドリキン", "2026-10-25T15:05:00Z", "/api/media/offkai-x.png"))
        // More than 999: as many digits as the count needs.
        assertEquals("0007_a_0900.jpg", OffkaiAlbumNames.fileName(6, 1200, "a", "2026-10-26T00:00:00.123Z", "/api/media/offkai-1.jpg"))
    }

    @Test fun uploaderIsMadeSafe() {
        // Separators and control characters dropped, spaces (also 全角) collapsed, trimmed.
        assertEquals("ドリキン mazzo", OffkaiAlbumNames.safePart("  ドリ\tキン / mazzo　 ", 16)) // (a tab is a control character: gone)
        assertEquals("abc", OffkaiAlbumNames.safePart("a\\b:c*?\"<>|\u0007\u007f", 16))
        assertEquals("123456789012345", OffkaiAlbumNames.safePart("123456789012345 6789", 16)) // 末尾の空白を落とす
        assertEquals("abc", OffkaiAlbumNames.safePart(". .abc", 16)) // 先頭の「.」と空白
        // At most 16 code points (an emoji is one, not two chars).
        assertEquals("🍻".repeat(16), OffkaiAlbumNames.safePart("🍻".repeat(20), 16))
        // Unicode format characters (Cf): U+202E would show 「gpj.exe」 backwards; U+200B / U+FEFF are invisible.
        assertEquals("abcgpj.exe", OffkaiAlbumNames.safePart("abc‮gpj.exe", 16))
        assertEquals("ドリキン", OffkaiAlbumNames.safePart("﻿ドリ​キン⁦", 16))
        // No leading dots (a hidden file).
        assertEquals("name", OffkaiAlbumNames.safePart("..name", 16))
        // Nothing left: no `_name` part.
        assertEquals("002_1930.jpg", OffkaiAlbumNames.fileName(1, 2, " / ", "2026-10-26T10:30:00Z", "/api/media/offkai-a.jpg"))
        assertEquals("002_1930.jpg", OffkaiAlbumNames.fileName(1, 2, null, "2026-10-26T10:30:00Z", "/api/media/offkai-a.jpg"))
    }

    @Test fun extensionLikeNode() {
        assertEquals(".jpg", OffkaiAlbumNames.extension("/api/media/offkai-a.JPG"))
        assertEquals(".webp", OffkaiAlbumNames.extension("https://bsm.backspace.fm/api/media/offkai-a.b.webp?x=1"))
        assertEquals("", OffkaiAlbumNames.extension("/api/media/offkai-a"))
        assertEquals("", OffkaiAlbumNames.extension("/api/media/.hidden"))
        assertEquals("image/png", OffkaiAlbumNames.mimeType("001_a_1930.png"))
        assertEquals("image/jpeg", OffkaiAlbumNames.mimeType("001_a_1930.jpg"))
    }

    @Test fun folderIsTheZipName() {
        // The day it started, in Japan (16:00Z = the next morning).
        assertEquals("B-guru オフ会 2026-10-26 渋谷 ハチ公前", OffkaiAlbumNames.folder("渋谷 ハチ公前", "2026-10-25T16:00:00Z"))
        assertEquals("B-guru オフ会 2026-10-25", OffkaiAlbumNames.folder("  ", "2026-10-25T14:59:00Z"))
        // The title: safe, at most 30.
        assertEquals("B-guru オフ会 2026-10-26 " + "あ".repeat(30), OffkaiAlbumNames.folder("あ".repeat(40), "2026-10-26T01:00:00Z"))
        assertEquals("B-guru オフ会 2026-10-26 秋葉原2次会", OffkaiAlbumNames.folder("秋葉原/2次会", "2026-10-26T01:00:00Z"))
    }

    @Test fun messages() {
        assertEquals("12 / 40", OffkaiAlbumNames.progress(12, 40))
        assertEquals("40 枚を保存しました", OffkaiAlbumNames.result(40, 0))
        assertEquals("38 枚を保存、2 枚は失敗", OffkaiAlbumNames.result(38, 2))
    }

    @Test fun canDownloadFromTheAlbum() {
        val yes = ApiJson.decodeFromString<OffkaiPhotosReply>("""{"photos":[],"next_after":null,"can_download":true}""")
        assertTrue(yes.canDownload)
        val old = ApiJson.decodeFromString<OffkaiPhotosReply>("""{"photos":[],"next_after":5}""")
        assertFalse(old.canDownload) // an older server: no button
        assertEquals(5L, old.nextAfter)
    }
}
