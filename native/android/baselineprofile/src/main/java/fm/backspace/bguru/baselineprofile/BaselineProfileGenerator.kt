package fm.backspace.bguru.baselineprofile

import android.content.ComponentName
import android.content.Intent
import androidx.benchmark.macro.junit4.BaselineProfileRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Until
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** What members do most: open the app, scroll the chat, switch to the timeline,
 *  scroll it (photos), open a thread and come back. Demo data, no network except
 *  the photos (served from the Mac by scripts/baseline-profile.sh). */
@RunWith(AndroidJUnit4::class)
class BaselineProfileGenerator {
    @get:Rule val rule = BaselineProfileRule()

    @Test
    fun generate() = rule.collect(packageName = PACKAGE, includeInStartupProfile = false) {
        pressHome()
        startActivityAndWait(
            Intent(Intent.ACTION_MAIN)
                .setComponent(ComponentName(PACKAGE, "fm.backspace.bguru.chat.MainActivity"))
                .putExtra("demo", true)
                .putExtra("demo_images", "http://10.0.2.2:8099")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK),
        )
        device.wait(Until.hasObject(By.textStartsWith("チャット")), 5_000)
        val w = device.displayWidth
        val h = device.displayHeight
        // Chat: newest at the bottom, scroll back in history and forward again.
        repeat(6) { device.swipe(w / 2, h / 4, w / 2, h * 3 / 4, 12); device.waitForIdle() }
        repeat(3) { device.swipe(w / 2, h * 3 / 4, w / 2, h / 4, 12); device.waitForIdle() }
        // Timeline.
        device.findObject(By.textStartsWith("タイムライン"))?.click()
        device.waitForIdle()
        repeat(8) { device.swipe(w / 2, h * 3 / 4, w / 2, h / 4, 12); device.waitForIdle() }
        repeat(3) { device.swipe(w / 2, h / 4, w / 2, h * 3 / 4, 12); device.waitForIdle() }
        // A thread and back.
        device.findObject(By.textContains("写真のテスト"))?.click()
        device.waitForIdle()
        Thread.sleep(1_000)
        device.pressBack()
        device.waitForIdle()
    }

    private companion object {
        const val PACKAGE = "fm.backspace.bguru.chat.bench"
    }
}
