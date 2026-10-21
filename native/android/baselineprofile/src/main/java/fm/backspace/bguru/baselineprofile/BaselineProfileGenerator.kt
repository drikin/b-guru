package fm.backspace.bguru.baselineprofile

import android.content.ComponentName
import android.content.Intent
import androidx.benchmark.macro.MacrobenchmarkScope
import androidx.benchmark.macro.junit4.BaselineProfileRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Until
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** What members do most: open the app, scroll the chat, switch to the timeline, scroll
 *  it (photos), open a thread and come back; the jukebox (the turntable playing, the
 *  record shelf scrolled) and the room (walking). Also the start-up profile (the code
 *  of the first screen, laid out together in the dex). Demo data, no network except
 *  the photos and the test audio (served from the Mac by scripts/baseline-profile.sh). */
@RunWith(AndroidJUnit4::class)
class BaselineProfileGenerator {
    @get:Rule val rule = BaselineProfileRule()

    @Test
    fun generate() = rule.collect(packageName = PACKAGE, includeInStartupProfile = true) {
        pressHome()
        startActivityAndWait(
            Intent(Intent.ACTION_MAIN)
                .setComponent(ComponentName(PACKAGE, "fm.backspace.bguru.chat.MainActivity"))
                .putExtra("demo", true)
                .putExtra("demo_images", "http://10.0.2.2:8099")
                .putExtra("demo_jukebox", "http://10.0.2.2:8098")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK),
        )
        // Android 13+ asks for notifications once: answer it so it does not cover the app.
        device.wait(Until.findObject(By.res("com.android.permissioncontroller:id/permission_deny_button")), 2_000)?.click()
        device.wait(Until.hasObject(By.text("テキスト")), 5_000)
        val w = device.displayWidth
        val h = device.displayHeight
        // Chat: newest at the bottom, scroll back in history and forward again.
        repeat(6) { device.swipe(w / 2, h / 4, w / 2, h * 3 / 4, 12); device.waitForIdle() }
        repeat(3) { device.swipe(w / 2, h * 3 / 4, w / 2, h / 4, 12); device.waitForIdle() }
        // Timeline (📰 in the switch at the top).
        tab("📰")
        repeat(8) { device.swipe(w / 2, h * 3 / 4, w / 2, h / 4, 12); device.waitForIdle() }
        repeat(3) { device.swipe(w / 2, h / 4, w / 2, h * 3 / 4, 12); device.waitForIdle() }
        // A thread and back.
        device.findObject(By.textContains("写真のテスト"))?.click()
        device.waitForIdle()
        Thread.sleep(1_000)
        device.pressBack()
        device.waitForIdle()
        // Jukebox: play (the turntable turns), scroll the shelf while it plays, pause.
        tab("📻")
        device.wait(Until.hasObject(By.textContains("年前の今ごろ")), 5_000)
        device.findObject(By.textContains("年前の今ごろ"))?.click()
        Thread.sleep(3_000)
        repeat(6) { device.swipe(w / 2, h * 3 / 4, w / 2, h / 4, 12); device.waitForIdle() }
        repeat(6) { device.swipe(w / 2, h / 4, w / 2, h * 3 / 4, 12); device.waitForIdle() }
        device.findObject(By.desc("一時停止"))?.click()
        device.waitForIdle()
        // Swipe back to the chat (the pager) and into the room: walk with the pad.
        device.swipe(w / 5, h / 2, w * 4 / 5, h / 2, 20)
        device.waitForIdle()
        device.findObject(By.textStartsWith("ルーム"))?.click()
        Thread.sleep(2_500)
        for (d in listOf("▶", "▼", "◀", "▲")) {
            device.findObject(By.desc(d))?.let { it.click(); Thread.sleep(400) }
        }
        Thread.sleep(1_500)
        device.findObject(By.text("テキスト"))?.click()
        device.waitForIdle()
    }

    private fun MacrobenchmarkScope.tab(mark: String) {
        device.findObject(By.text(mark))?.click()
        device.waitForIdle()
        Thread.sleep(500)
    }

    private companion object {
        const val PACKAGE = "fm.backspace.bguru.chat.bench"
    }
}
