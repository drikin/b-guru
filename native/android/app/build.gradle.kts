import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

fun props(name: String): Properties = Properties().apply {
    val f = rootProject.file(name)
    if (f.exists()) f.inputStream().use { load(it) }
}

// Firebase (FCM) client config. Not secret (it ships inside every APK), but it is
// per-project, so it lives in firebase.properties; without it the app simply
// runs without push. No google-services plugin: Firebase is initialised in code.
val firebase = props("firebase.properties")
// Release signing: keystore.properties + the .jks stay outside the repo.
val signing = props("keystore.properties")

val demoWebDir = layout.buildDirectory.dir("generated/demoWeb")
val demoWebAssets = tasks.register<Sync>("demoWebAssets") {
    from(rootProject.file("../../public/shogi-board")) { into("shogi-board") }
    from(rootProject.file("../../public/minigame")) { into("minigame") }
    into(demoWebDir)
}
tasks.named("preBuild") { dependsOn(demoWebAssets) }

android {
    namespace = "fm.backspace.bguru.chat"
    compileSdk = 37

    defaultConfig {
        applicationId = "fm.backspace.bguru.chat"
        minSdk = 28
        targetSdk = 36
        versionCode = (findProperty("versionCode") as String?)?.toInt() ?: 1
        versionName = (findProperty("versionName") as String?) ?: "0.1.0"
        // Phones only (arm): WebRTC's native code for x86 would double the APK for nobody.
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a") }
        // Sample data (`--ez demo true`): debug and the benchmark build only, never a release.
        buildConfigField("boolean", "DEMO", "false")
        for (k in listOf("apiKey", "appId", "projectId", "senderId")) {
            buildConfigField("String", "FCM_${k.uppercase()}", "\"${firebase.getProperty(k, "")}\"")
        }
    }

    signingConfigs {
        if (signing.getProperty("storeFile") != null) {
            create("release") {
                storeFile = file(signing.getProperty("storeFile"))
                storePassword = signing.getProperty("storePassword")
                keyAlias = signing.getProperty("keyAlias")
                keyPassword = signing.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfigs.findByName("release")?.let { signingConfig = it }
        }
        debug {
            applicationIdSuffix = ".debug"
            buildConfigField("boolean", "DEMO", "true")
        }
        // Release code and optimisation (R8, not debuggable) with the demo data, signed
        // with the debug key — for measuring scrolling and generating the baseline profile.
        create("benchmark") {
            initWith(getByName("release"))
            signingConfig = signingConfigs.getByName("debug")
            matchingFallbacks += "release"
            applicationIdSuffix = ".bench"
            isDebuggable = false
            buildConfigField("boolean", "DEMO", "true")
        }
        // Same, without R8 renaming: the baseline-profile generator records real class
        // names here, and the release build's R8 maps them to its own.
        create("profile") {
            initWith(getByName("benchmark"))
            isMinifyEnabled = false
            isShrinkResources = false
            applicationIdSuffix = ".bench"
        }
    }

    // Demo (`--ez demo true`): the ☗ board and the 🎮 game pages straight from this repo
    // (public/shogi-board, public/minigame → assets shogi-board/, minigame/), so the demo runs
    // without the network. Demo-capable builds only, never a release.
    for (bt in listOf("debug", "benchmark", "profile")) {
        sourceSets.getByName(bt).assets.directories.add(demoWebDir.get().asFile.path)
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2026.08.00")
    implementation(composeBom)
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material:material-icons-core")
    implementation("androidx.activity:activity-compose:1.12.4")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.10.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    implementation("com.squareup.okhttp3:okhttp:5.4.0")
    // Installs the bundled baseline profile (src/main/baseline-prof.txt) on sideloaded installs too.
    implementation("androidx.profileinstaller:profileinstaller:1.4.1")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.10.0")
    implementation("com.google.firebase:firebase-messaging:25.1.3")
    // Voice room (LiveKit, Apache-2.0, official SDK) — same server and rules as iOS/Mac.
    implementation("io.livekit:livekit-android:2.29.0")
    // Jukebox (backspace.fm back catalogue): ExoPlayer + a MediaSessionService for
    // background playback, the notification, lock screen and Bluetooth buttons (Google, Apache-2.0).
    implementation("androidx.media3:media3-exoplayer:1.11.1")
    implementation("androidx.media3:media3-session:1.11.1")
    debugImplementation("androidx.compose.ui:ui-tooling")
    testImplementation("junit:junit:4.13.2")
}
