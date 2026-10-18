// Versions are pinned (no "+"), official publishers only: Google (AGP, AndroidX,
// Firebase, Baseline Profile tooling), JetBrains (Kotlin, kotlinx.serialization), Square (OkHttp).
plugins {
    id("com.android.application") version "9.4.0" apply false
    id("com.android.test") version "9.4.0" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.10" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.4.10" apply false
}
