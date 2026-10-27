package fm.backspace.bguru.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class CustomEmojiRulesTest {
    private val R = CustomEmojiRules

    @Test fun normalizeStripsColonsSpacesAndLowercases() {
        assertEquals("party_parrot", R.normalize("  :Party_Parrot: "))
        assertEquals("abc", R.normalize("abc"))
        assertEquals("", R.normalize(" :: "))
    }

    @Test fun nameRulesMatchTheServer() {
        // サーバ: /^[a-z0-9_]{1,32}$/
        assertNull(R.nameError("a"))
        assertNull(R.nameError("drikin_2026"))
        assertNull(R.nameError("x".repeat(32)))
        assertNotNull(R.nameError(""))
        assertEquals("名前は 32 文字までです", R.nameError("x".repeat(33)))
        assertNotNull(R.nameError("a-b"))
        assertNotNull(R.nameError("a b"))
        assertNotNull(R.nameError("ビーグル"))
        assertNotNull(R.nameError("ABC")) // normalize してから確かめる前提
    }

    @Test fun takenNameIsAnErrorBeforeSending() {
        assertEquals("その名前は既に使われています", R.nameError("beagle", setOf("beagle", "drikin")))
        assertNull(R.nameError("beagle2", setOf("beagle")))
    }

    @Test fun suggestNameFromFileName() {
        assertEquals("party_parrot", R.suggestName("Party Parrot.gif"))
        assertEquals("img_2026", R.suggestName("IMG-2026.JPG"))
        assertNull(R.suggestName("写真.png"))
        assertNull(R.suggestName(null))
        assertEquals(32, R.suggestName("a".repeat(40) + ".png")!!.length)
    }

    @Test fun gifIsKeptOnlyUpTo256KB() {
        assertEquals(CustomEmojiRules.Output.GIF, R.chooseOutput("image/gif", 1000))
        assertEquals(CustomEmojiRules.Output.GIF, R.chooseOutput("image/gif", 256L * 1024))
        assertEquals(CustomEmojiRules.Output.PNG, R.chooseOutput("image/gif", 256L * 1024 + 1))
        assertEquals(CustomEmojiRules.Output.PNG, R.chooseOutput("image/png", 1000))
        assertEquals(CustomEmojiRules.Output.PNG, R.chooseOutput("image/jpeg", 1000))
        assertEquals(CustomEmojiRules.Output.PNG, R.chooseOutput("image/webp", 1000))
        assertEquals(CustomEmojiRules.Output.PNG, R.chooseOutput(null, 1000))
    }

    @Test fun sniffMimeFromBytes() {
        assertEquals("image/gif", R.sniffMime("GIF89a".toByteArray(), "image/png"))
        assertEquals("image/png", R.sniffMime(byteArrayOf(0x89.toByte(), 'P'.code.toByte(), 'N'.code.toByte(), 'G'.code.toByte(), 13, 10, 26, 10), null))
        assertEquals("image/jpeg", R.sniffMime(byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xE0.toByte()), null))
        assertEquals("image/webp", R.sniffMime("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ".toByteArray(Charsets.ISO_8859_1), null))
        assertEquals("image/heic", R.sniffMime(byteArrayOf(0, 0, 0, 0x18), "image/heic"))
    }

    @Test fun fitShrinksTheLongSideTo128AndNeverEnlarges() {
        assertEquals(128 to 64, R.fit(1024, 512))
        assertEquals(64 to 128, R.fit(500, 1000))
        assertEquals(32 to 20, R.fit(32, 20))
        assertEquals(128 to 1, R.fit(4000, 10))
        assertEquals(1 to 1, R.fit(0, 0))
    }

    @Test fun errorTextForServerCodes() {
        assertEquals("その名前は既に使われています", R.errorText(409, "name_taken", "その名前は既に使われています"))
        assertEquals("画像は256KBまでです", R.errorText(400, "too_large", null))
        assertEquals("登録が多すぎます。少し待ってください", R.errorText(429, "rate_limited", null))
        assertEquals("削除が多すぎます。少し待ってください", R.errorText(429, "rate_limited", null, deleting = true))
        assertEquals("通信できませんでした。もう一度試してください", R.errorText(null, null, null))
        assertEquals("PNG / GIF / WebP / JPEG のみ登録できます", R.errorText(400, "invalid_request", "PNG / GIF / WebP / JPEG のみ登録できます"))
        assertEquals("登録できませんでした（500）", R.errorText(500, null, null))
    }

    @Test fun deleteWording() {
        assertEquals(":beagle: を削除", R.deleteTitle("beagle"))
        assertEquals(":beagle: を削除すると、この絵文字のリアクションも全部消えます", R.deleteBody("beagle"))
    }
}
