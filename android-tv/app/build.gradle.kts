import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Resolve the kids client URL at configuration time. Order of precedence:
//   1) local.properties `jellybean.url` (gitignored, per-machine override)
//   2) gradle.properties `jellybean.url` (committed default)
//   3) hardcoded fallback for the emulator
val jellybeanUrl: String = run {
    val localProps = Properties()
    val localFile = rootProject.file("local.properties")
    if (localFile.exists()) {
        localFile.inputStream().use { localProps.load(it) }
    }
    localProps.getProperty("jellybean.url")
        ?: (project.findProperty("jellybean.url") as String?)
        ?: "http://10.0.2.2:8080/kids/"
}

android {
    namespace = "com.fisherevans.jellybean"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.fisherevans.jellybean"
        minSdk = 21
        targetSdk = 33
        versionCode = 1
        versionName = "0.1.0"

        // Injected as BuildConfig.JELLYBEAN_URL; quoted because
        // buildConfigField writes the raw expression into generated Java.
        buildConfigField("String", "JELLYBEAN_URL", "\"$jellybeanUrl\"")
    }

    buildFeatures {
        buildConfig = true
    }

    signingConfigs {
        // Debug builds use Android's default ~/.android/debug.keystore so
        // a fresh checkout produces a sideloadable APK with no extra setup.
        // The default config Android creates already points at debug.keystore;
        // we keep it explicit here for readability.
        getByName("debug") {
            // Android Gradle Plugin auto-populates this with the default
            // debug keystore. No action required.
        }

        // TODO: release signing config. Generate a keystore locally with
        //   keytool -genkey -v -keystore jellybean-release.jks \
        //     -keyalg RSA -keysize 2048 -validity 10000 -alias jellybean
        // Reference it from a per-machine ~/.gradle/gradle.properties or
        // from local.properties so secrets stay out of the repo. Example:
        //   create("release") {
        //       storeFile = file(System.getenv("JELLYBEAN_KEYSTORE") ?: "")
        //       storePassword = System.getenv("JELLYBEAN_KEYSTORE_PASSWORD")
        //       keyAlias = System.getenv("JELLYBEAN_KEY_ALIAS")
        //       keyPassword = System.getenv("JELLYBEAN_KEY_PASSWORD")
        //   }
    }

    buildTypes {
        getByName("debug") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        getByName("release") {
            isMinifyEnabled = false
            // TODO: wire signingConfig once a release keystore exists.
            // signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("androidx.webkit:webkit:1.10.0")
}
