pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // LiveKit's audio routing library is published only on JitPack (built from a
        // pinned commit). Only that one module may come from there — nothing else can.
        exclusiveContent {
            forRepository { maven("https://jitpack.io") }
            filter { includeModule("com.github.davidliu", "audioswitch") }
        }
    }
}
rootProject.name = "BguruChat"
include(":app")
include(":baselineprofile")
