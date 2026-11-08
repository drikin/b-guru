package fm.backspace.bguru.chat

import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 📷 Photos in DMs (docs/dm-photos-spec.md) and pasting images into the composers. */
class DMPhotosTest {
    // MARK: wire

    @Test fun dmMessageImagesDefaultToEmptyAndDecode() {
        val old = ApiJson.decodeFromString<DMMessage>("""{"id":1,"peer_id":"a","body":"hi"}""")
        assertEquals(emptyList<String>(), old.images)
        val withPhotos = ApiJson.decodeFromString<DMMessage>("""{"id":2,"peer_id":"a","body":"","images":["/api/media/dm-1-a.jpg","/api/media/dm-2-b.jpg"]}""")
        assertEquals(listOf("/api/media/dm-1-a.jpg", "/api/media/dm-2-b.jpg"), withPhotos.images)
        val ev = ApiJson.decodeFromString<DMEvent>("""{"action":"create","message":{"id":3,"peer_id":"a","body":"","images":["/api/media/dm-3.jpg"]}}""")
        assertEquals(listOf("/api/media/dm-3.jpg"), ev.message?.images)
    }

    @Test fun groupMessageImagesDefaultToEmptyAndDecode() {
        assertEquals(emptyList<String>(), ApiJson.decodeFromString<GMessage>("""{"id":1,"group_id":2,"body":"x"}""").images)
        val m = ApiJson.decodeFromString<GMessage>("""{"id":1,"group_id":2,"body":"","from_name":"mazzo","images":["/api/media/dm-9.jpg"]}""")
        assertEquals(listOf("/api/media/dm-9.jpg"), m.images)
    }

    @Test fun capabilitiesOfferPhotosOnlyWithAnUploadPathOnOurServer() {
        val on = ApiJson.decodeFromString<Capabilities>(
            """{"features":{"dm":{"enabled":true,"send":true,"max_images":4,"upload_path":"/api/agent/dm/upload"}}}""")
        assertTrue(on.canSendDMImages)
        assertEquals("/api/agent/dm/upload", on.dmImageUpload)
        assertEquals(4, on.dmMaxImages)
        // A server before DM photos: no button.
        assertFalse(ApiJson.decodeFromString<Capabilities>("""{"features":{"dm":{"enabled":true,"send":true}}}""").canSendDMImages)
        // Never upload with the token to another host.
        assertFalse(ApiJson.decodeFromString<Capabilities>(
            """{"features":{"dm":{"enabled":true,"send":true,"upload_path":"https://evil.example/u"}}}""").canSendDMImages)
        // Read-only token.
        assertFalse(ApiJson.decodeFromString<Capabilities>(
            """{"features":{"dm":{"enabled":true,"send":false,"upload_path":"/api/agent/dm/upload"}}}""").canSendDMImages)
    }

    // MARK: texts

    @Test fun photoOnlyMessagesSayPhotoInTheListAndNotifications() {
        val photo = DMMessage(1, peerId = "a", body = "", images = listOf("/api/media/dm-1.jpg"))
        assertEquals("📷 写真", DMLogic.preview(photo))
        assertEquals("あなた: 📷 写真", DMLogic.preview(photo.copy(isAuthor = true)))
        assertEquals("見て", DMLogic.preview(photo.copy(body = "見て")))
        assertEquals("📷 写真", DMLogic.notificationText("", listOf("/api/media/dm-1.jpg")))
        assertEquals("", DMLogic.notificationText("", emptyList()))
        assertEquals("mazzoさんからの DM" to "📷 写真", PushContent.dmContent("mazzo", "", listOf("/api/media/dm-1.jpg")))
        assertEquals("mazzoさんからの DM" to "やあ", PushContent.dmContent("mazzo", "やあ", listOf("/api/media/dm-1.jpg")))

        val g = GMessage(1, 2, fromName = "mazzo", body = "", images = listOf("/api/media/dm-2.jpg"))
        assertEquals("mazzo: 📷 写真", GDMLogic.preview(g))
        assertEquals("あなた: 📷 写真", GDMLogic.preview(g.copy(isAuthor = true)))
        assertEquals("mazzo: 📷 写真", GDMLogic.notificationText("mazzo", "", g.images))
        assertEquals("mazzo: やあ", GDMLogic.notificationText("mazzo", "やあ", g.images))
    }

    @Test fun canSendTextOrPhotos() {
        assertTrue(DMLogic.canSend("hi", 0))
        assertTrue(DMLogic.canSend("", 1))
        assertTrue(DMLogic.canSend("  ", 2))
        assertFalse(DMLogic.canSend("  ", 0))
    }

    // MARK: optimistic bubbles

    @Test fun reconcileKeepsTheLocalPreviewsWhenTheStoredDMArrives() {
        val pending = DMRow(DMMessage(-1, peerId = "a", body = "", isAuthor = true, clientId = "c1"), SendState.PENDING)
        val stored = DMMessage(10, peerId = "a", body = "", isAuthor = true, clientId = "c1", images = listOf("/api/media/dm-1.jpg"))
        val out = DMLogic.reconcile(listOf(pending), stored)
        assertEquals(1, out.size)
        assertEquals(stored, out[0].message)
        assertEquals("c1", out[0].key)
        assertEquals(SendState.SENT, out[0].state)
    }

    // MARK: paste

    @Test fun pasteTakesImageItemsOnly() {
        // A copied image: one uri, typed image/png.
        assertEquals(listOf(0), PasteImages.imageItems(listOf("content://x/1"), listOf("image/png"), listOf("image/png")))
        // Text only: nothing to attach (the field pastes the text).
        assertEquals(emptyList<Int>(), PasteImages.imageItems(listOf(null), listOf(null), listOf("text/plain")))
        // A uri the resolver can't type counts when the clip says it is an image (Gboard's inserts).
        assertEquals(listOf(0), PasteImages.imageItems(listOf("content://kbd/1"), listOf(null), listOf("image/gif")))
        // ... but not when the clip is not an image.
        assertEquals(emptyList<Int>(), PasteImages.imageItems(listOf("content://x/1"), listOf(null), listOf("text/uri-list")))
        // A known non-image uri (a PDF) is never a photo.
        assertEquals(emptyList<Int>(), PasteImages.imageItems(listOf("content://x/1"), listOf("application/pdf"), listOf("image/png")))
        // Mixed: text and two images.
        assertEquals(listOf(1, 2), PasteImages.imageItems(listOf(null, "content://x/1", "content://x/2"), listOf(null, "image/jpeg", "IMAGE/HEIC"), listOf("text/plain", "image/jpeg")))
    }

    @Test fun pasteRespectsTheFourPhotoLimit() {
        assertEquals(2, PasteImages.fits(2, 4))
        assertEquals(1, PasteImages.fits(3, 1))
        assertEquals(0, PasteImages.fits(1, 0))
        assertEquals(0, PasteImages.fits(1, -1))
        assertNull(PasteImages.overflowMessage(2, 2, 4))
        assertEquals("写真は 4 枚までです", PasteImages.overflowMessage(3, 2, 4))
        assertEquals("写真は 4 枚までです", PasteImages.overflowMessage(1, 0, 4))
    }

    @Test fun onlyRealOutsideChangesAreWrittenIntoTheField() {
        val typed = TextFieldValue("abc", TextRange(3))
        // The field's own echo (even with a composition the caller dropped) is not written back.
        assertFalse(PasteImages.isOutsideChange(TextFieldValue("abc", TextRange(3)), typed))
        assertFalse(PasteImages.isOutsideChange(TextFieldValue("abc", TextRange(3), TextRange(0, 3)), typed))
        // Cleared after send, a mention picked, a cursor moved by the caller: written.
        assertTrue(PasteImages.isOutsideChange(TextFieldValue(""), typed))
        assertTrue(PasteImages.isOutsideChange(TextFieldValue("@mazzo abc", TextRange(10)), typed))
        assertTrue(PasteImages.isOutsideChange(TextFieldValue("abc", TextRange(1)), typed))
    }

    @Test fun draftLimitKeepsTheCursorInside() {
        val v = TextFieldValue("abcdef", TextRange(6)).limitTo(4)
        assertEquals("abcd", v.text)
        assertEquals(TextRange(4), v.selection)
        val same = TextFieldValue("ab", TextRange(1))
        assertEquals(same, same.limitTo(4))
    }
}
