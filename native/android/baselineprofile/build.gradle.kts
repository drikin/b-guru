// Generates app/src/main/baseline-prof.txt: drives the benchmark build (release code,
// demo data) through the chat and the timeline and records the code they run, so
// Android compiles it ahead of time instead of interpreting it on the first scrolls.
//
//   ./gradlew :baselineprofile:connectedProfileAndroidTest   (emulator API 33+, see scripts/baseline-profile.sh)
plugins {
    id("com.android.test")
}

android {
    namespace = "fm.backspace.bguru.baselineprofile"
    compileSdk = 37

    defaultConfig {
        minSdk = 28
        targetSdk = 36
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        create("profile") {
            isDebuggable = true
            signingConfig = signingConfigs.getByName("debug")
            matchingFallbacks += "release"
        }
    }

    targetProjectPath = ":app"
    experimentalProperties["android.experimental.self-instrumenting"] = true

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("androidx.benchmark:benchmark-macro-junit4:1.5.0")
    implementation("androidx.test.uiautomator:uiautomator:2.4.0")
    implementation("androidx.test.ext:junit:1.3.0")
}
