package fm.backspace.bguru.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 📺 YouTube 共同鑑賞: which links get 「みんなで見る」 (the server checks again). */
class WatchLogicTest {
    @Test fun videoUrls() {
        assertTrue(WatchLogic.isVideoUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s"))
        assertTrue(WatchLogic.isVideoUrl("https://youtu.be/dQw4w9WgXcQ?si=abc"))
        assertTrue(WatchLogic.isVideoUrl("https://m.youtube.com/shorts/dQw4w9WgXcQ"))
        assertTrue(WatchLogic.isVideoUrl("https://www.youtube.com/live/dQw4w9WgXcQ"))
        assertFalse(WatchLogic.isVideoUrl("https://www.youtube.com/@backspacefm"))
        assertFalse(WatchLogic.isVideoUrl("https://evil.example/watch?v=dQw4w9WgXcQ"))
        assertFalse(WatchLogic.isVideoUrl("https://www.youtube.com.evil.example/watch?v=dQw4w9WgXcQ"))
        assertFalse(WatchLogic.isVideoUrl("javascript:alert(1)"))
    }

    @Test fun firstVideoInChat() {
        assertEquals("https://youtu.be/dQw4w9WgXcQ", WatchLogic.firstVideoUrl("これ見て https://youtu.be/dQw4w9WgXcQ）"))
        assertEquals("https://www.youtube.com/watch?v=9bZkp7q19f0",
            WatchLogic.firstVideoUrl("https://example.com と https://www.youtube.com/watch?v=9bZkp7q19f0"))
        assertNull(WatchLogic.firstVideoUrl("リンクなし"))
    }
}
