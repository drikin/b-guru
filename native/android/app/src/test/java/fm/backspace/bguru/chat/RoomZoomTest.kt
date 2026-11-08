package fm.backspace.bguru.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The room's zoom (drikin 2026-11-08): auto × the member's scale, between "the whole map" and 2 × auto. */
class RoomZoomTest {
    // A phone: 1080 px wide (411 dp), the map 40 × 24 tiles, a view 1080 × 900 px.
    private val w = 1080f; private val h = 900f; private val dp = 411f
    private fun s(scale: Float) = RoomZoom.scale(w, h, dp, 40, 24, scale)

    @Test fun oneIsTheAutomaticScaleOfBefore() {
        val z = s(1f)
        assertEquals(5f, z.auto, 0f) // floor(1080 / (16 × 13))
        assertEquals(5f, z.zoom, 0f)
        assertEquals(1f, z.scale, 1e-6f)
    }

    @Test fun boundsAreTheWholeMapAndTwiceAuto() {
        val fit = minOf(w / (40 * 16), h / (24 * 16)) // 1.6875
        assertEquals(fit, s(0.01f).zoom, 1e-4f)
        assertEquals(10f, s(9f).zoom, 0f)
        assertEquals(fit / 5f, s(1f).minScale, 1e-4f)
        assertEquals(2f, s(1f).maxScale, 1e-6f)
    }

    @Test fun badStoredScaleIsOne() {
        assertEquals(5f, s(Float.NaN).zoom, 0f)
        assertEquals(5f, s(0f).zoom, 0f)
        assertEquals(5f, s(-2f).zoom, 0f)
    }

    @Test fun smallMapKeepsTheOldLook() {
        // The whole map already fits at the automatic scale: 1.0 stays the lower bound.
        val z = RoomZoom.scale(1080f, 900f, 411f, 10, 8, 0.5f)
        assertEquals(z.auto, z.min, 0f)
        assertEquals(z.auto, z.zoom, 0f)
        assertTrue(z.atFit)
    }

    @Test fun buttonsStepAndClamp() {
        assertEquals(1.25f, RoomZoom.zoomIn(s(1f)), 1e-6f)
        assertEquals(0.8f, RoomZoom.zoomOut(s(1f)), 1e-6f)
        assertEquals(2f, RoomZoom.zoomIn(s(1.9f)), 1e-6f)
        assertEquals(s(1f).minScale, RoomZoom.zoomOut(s(0.34f)), 1e-6f)
        assertEquals(1.5f, RoomZoom.pinch(s(1f), 1.5f), 1e-6f)
        assertEquals(2f, RoomZoom.pinch(s(1f), 4f), 1e-6f)
    }

    @Test fun wholeMapTogglesWithOne() {
        val fit = RoomZoom.toggleFit(s(1f))
        assertEquals(s(1f).minScale, fit, 1e-6f)
        assertTrue(s(fit).atFit)
        assertEquals(1f, RoomZoom.toggleFit(s(fit)), 0f)
        assertFalse(s(1.25f).atFit)
        assertEquals(s(1f).minScale, RoomZoom.toggleFit(s(1.25f)), 1e-6f)
    }

    @Test fun cameraFollowsClampsAndCentres() {
        // Map 640 px wide, view 1080 px at zoom 5 = 216 map px.
        assertEquals(0f, RoomZoom.cam(10f, 640, 1080f, 5f), 0f) // near the left edge
        assertEquals(640f - 216f, RoomZoom.cam(630f, 640, 1080f, 5f), 0f) // near the right edge
        assertEquals(300f - 108f, RoomZoom.cam(300f, 640, 1080f, 5f), 0f) // centred on me
        // The map smaller than the view: centred whoever is where.
        assertEquals(-(800f - 640f) / 2, RoomZoom.cam(600f, 640, 1080f, 1080f / 800f), 0.5f)
        assertEquals(-(800f - 640f) / 2, RoomZoom.cam(null, 640, 1080f, 1080f / 800f), 0.5f)
    }

    @Test fun cameraSnapsToWholeScreenPixels() {
        val z = 6.25f
        val c = RoomZoom.cam(301.3f, 640, 1080f, z)
        assertEquals(Math.round(c * z).toFloat(), c * z, 1e-3f)
    }

    @Test fun tapToTileAtAFractionalZoom() {
        // cam 100 map px, zoom 2.5: screen 50 → map 120 → tile 7.
        assertEquals(7, RoomZoom.tileAt(50f, 100f, 2.5f))
        assertEquals(-1, RoomZoom.tileAt(10f, -20f, 2.5f))
    }

    @Test fun textShrinksLessThanTheArt() {
        assertEquals(5f, RoomZoom.textZoom(s(1f)), 0f)
        assertEquals(10f, RoomZoom.textZoom(s(2f)), 0f)
        assertEquals(2.75f, RoomZoom.textZoom(s(0.01f)), 1e-6f)
    }

    @Test fun expandedLeavesTheChatAFewLines() {
        assertEquals(1000f * 0.85f, RoomViewPrefs.expandedHeight(1000f), 1e-3f)
        assertEquals(700f - 140f, RoomViewPrefs.expandedHeight(700f), 1e-3f)
        assertEquals(200f * 0.5f, RoomViewPrefs.expandedHeight(200f), 1e-3f)
    }
}
