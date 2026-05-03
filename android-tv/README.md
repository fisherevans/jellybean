# Jellybean Android TV shell

Minimal Kotlin Activity that wraps the kids client web app in a WebView,
packaged as a leanback-launcher APK for sideloading to Android TV / Google
TV. This is the M5 first real-TV target; primary device is a Skyworth
Android TV 11 (API 30).

The full sideload runbook (enabling dev mode on the TV, `adb connect`, the
`scripts/jb-tv` workflow, troubleshooting) lives in
[`../docs/tv-android.md`](../docs/tv-android.md). This README is the short
version.

## Quick build

Requires Android SDK + a system `gradle` 8.x, or run `gradle wrapper` once
to produce `gradlew`. Wrappers are intentionally not committed.

```bash
cd android-tv
gradle wrapper          # one-time, if you want ./gradlew
./gradlew :app:assembleDebug
# APK at: app/build/outputs/apk/debug/app-debug.apk
```

Or use the helper from the repo root:

```bash
./scripts/jb-tv connect 192.168.x.y      # adb connect <ip>:5555
./scripts/jb-tv install                  # build + adb install -r
./scripts/jb-tv launch                   # start MainActivity
./scripts/jb-tv logs                     # tail logcat for our package
```

## Configuring the kids client URL

Override the build-time URL by adding `jellybean.url` to `local.properties`
(gitignored). The committed `gradle.properties` ships with the emulator
loopback as a default.

```properties
# android-tv/local.properties
jellybean.url=http://192.168.1.42:8080/kids/
# or
jellybean.url=https://jellybean.example.com/kids/
```

The value is injected as `BuildConfig.JELLYBEAN_URL` at compile time.

## Pinned versions

| Tool | Version |
| --- | --- |
| Android Gradle Plugin | 8.2.2 |
| Kotlin | 1.9.22 |
| compileSdk | 34 |
| targetSdk | 33 |
| minSdk | 21 |
| JDK (Gradle) | 17 |
