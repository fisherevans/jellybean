// Top-level build file. Configuration shared across all modules lives here.
//
// Plugin versions are pinned conservatively. AGP 8.2.x pairs with Kotlin
// 1.9.x and requires JDK 17 to run Gradle itself; the produced APK still
// targets minSdk 21 / targetSdk 33.
plugins {
    id("com.android.application") version "8.2.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.22" apply false
}
