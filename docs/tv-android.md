# Android TV sideload runbook

How to put the Jellybean kids client on a Skyworth Android TV 11 (API 30)
or any other Android TV / Google TV box with sideload turned on. The
shape of the work: a single-Activity Kotlin app whose only job is to
fullscreen a WebView pointing at `https://<host>/kids/`. Source under
[`../android-tv/`](../android-tv/).

## Prereqs on your dev machine

- JDK 17 (Gradle 8.x runs on it; AGP 8.2 requires it).
- Android SDK platform-tools (`adb`) on `PATH`. Easiest path is
  `brew install --cask android-platform-tools` on macOS.
- Either system `gradle` 8.x (`brew install gradle`) or run
  `cd android-tv && gradle wrapper` once to generate `gradlew`. The
  wrapper jar is intentionally not committed.

The Android SDK itself comes from Android Studio or `cmdline-tools`; AGP
will fetch the build-tools / platforms it needs on first build.

## Enabling Developer Options on the TV

Android TV / Google TV hides Developer Options the same way phones do.

1. **Settings -> System -> About**.
2. Scroll to **Build** (sometimes "Android TV OS build" or "Build number").
3. Click it 7 times. You'll get a "You are now a developer" toast.
4. Back out one level. **Developer options** should now be visible.

In Developer options:

- Turn on **USB debugging** (used over USB) **and** **Network debugging**
  / **Wireless debugging** (used over the LAN). Names vary by Skyworth
  firmware revision; flip both if both exist.
- Note the IP address shown for network debugging. On stock Android TV
  it's usually under **Settings -> Network & Internet -> [your network]
  -> IP address** if it isn't surfaced next to the toggle.

The TV will reject connections from random hosts on first contact. The
RSA fingerprint dialog only shows up when `adb connect` is in flight, so
do not click "always allow" until you've actually run the connect step
below.

## Pointing the build at the right URL

The kids client URL is baked into the APK at build time. Set it in
`android-tv/local.properties` (gitignored, per-machine):

```properties
# dev: LAN IP of the machine running ./scripts/jb start
jellybean.url=http://192.168.1.42:8080/kids/

# production: the Cloudflare tunnel hostname
jellybean.url=https://jellybean.example.com/kids/
```

The committed default in `gradle.properties` is `http://10.0.2.2:8080/kids/`
which is the Android emulator's loopback alias for the host. Real TVs
need a routable address, so override it.

`android:usesCleartextTraffic="true"` is set in the manifest so the
plain-`http://` LAN setup works without HTTPS. For wider distribution
you'd swap that to `false` and use the production hostname only - but
this is a sideload-on-personal-LAN tool, and the trade-off is worth it.

## First-time sideload

From the repo root:

```bash
./scripts/jb-tv connect 192.168.1.55     # whatever the TV's IP is
# Look at the TV - accept the RSA fingerprint prompt now.
./scripts/jb-tv install                  # builds the APK and installs it
./scripts/jb-tv launch                   # opens it on the TV
```

After the first `connect + install + launch`, the app shows up on the
Google TV home row under "Your apps" (banner: the Jellybean kids logo,
which is square not 320x180 and should be replaced with a proper banner
before any wider distribution).

To iterate:

```bash
./scripts/jb-tv install                  # reinstall in place
./scripts/jb-tv logs                     # tail logcat filtered to our package
```

## What's actually in the APK

- `MainActivity.kt`: ~150 lines. Sets up a single full-screen WebView,
  enables JavaScript / DOM storage / database storage, hides system
  bars via `WindowInsetsControllerCompat`, hooks BACK to walk the web
  back-stack before exiting.
- `AndroidManifest.xml`: declares `LEANBACK_LAUNCHER` so the app appears
  on the TV home row, marks `android.software.leanback` required, marks
  touchscreen not-required, opts in to cleartext traffic.
- `BuildConfig.JELLYBEAN_URL`: compile-time string, sourced from
  `local.properties` -> `gradle.properties` -> hardcoded fallback.

D-pad behaviour is "do nothing": Android already routes `DPAD_*` events
to the focused View, and a focused WebView turns them into `keydown`
events on the embedded page. The kids client's existing focus model
handles the rest. If a key isn't reaching the page, the issue is almost
always that something else has focus - see Troubleshooting below.

## Release signing (not in source)

The committed Gradle config has a TODO block for the release signing
config but no keystore. Keep it that way. To produce a signed release
APK locally:

```bash
keytool -genkey -v \
  -keystore ~/.keystores/jellybean-release.jks \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -alias jellybean

# Then add to ~/.gradle/gradle.properties (NOT android-tv/gradle.properties):
#   JELLYBEAN_KEYSTORE=/Users/you/.keystores/jellybean-release.jks
#   JELLYBEAN_KEYSTORE_PASSWORD=...
#   JELLYBEAN_KEY_ALIAS=jellybean
#   JELLYBEAN_KEY_PASSWORD=...
```

Wire those into `app/build.gradle.kts`'s `signingConfigs.release` (the
TODO block shows the shape) before running `:app:assembleRelease`.

## Troubleshooting

### "WebView shows blank screen"

- The TV can't reach `BuildConfig.JELLYBEAN_URL`. SSH or otherwise log in
  to the TV's network and `curl` the URL from a host on the same VLAN /
  subnet. If the dev box uses a firewall, open the Jellybean port (8080
  by default) for the TV's IP.
- The URL is `https://` but uses a self-signed cert. WebView won't load
  it. Use `http://` on the LAN, or front Jellybean with a real cert.
- The URL is `http://` but `usesCleartextTraffic` got flipped to `false`.
  The manifest in `android-tv/app/src/main/AndroidManifest.xml` should
  still have it `true` for sideload builds.
- The kids SPA crashed. `./scripts/jb-tv logs` filters logcat to our
  package and forwards `chromium` / `WebView` lines too.

### "App icon doesn't show on Google TV home"

- The `LEANBACK_LAUNCHER` intent-filter category is missing or the
  `android:banner` attribute on `<application>` isn't set. Both are
  required by the leanback launcher.
- The banner asset is missing or unreadable. Confirm
  `android-tv/app/src/main/res/drawable/banner.png` exists.
- The TV cached the previous APK's metadata. Reboot the TV or
  `adb shell am force-stop com.google.android.tvlauncher` then relaunch
  the launcher.

### "DPad doesn't work"

- Focus is not in the WebView. The kids SPA is responsible for placing
  focus on a focusable element on first paint. If that fails, Android
  delivers DPad events to the WebView host but the page does nothing
  with them.
- A system overlay grabbed focus (Google Assistant, accessibility
  services, etc.). Press BACK once to dismiss.
- BACK exits to the launcher. That's expected when the WebView's history
  stack is at the root - `MainActivity.onKeyDown` falls through to the
  default handler in that case.

### "adb connect 192.168.x.y:5555 fails"

- Port 5555 isn't open. On Skyworth's firmware, network debugging
  sometimes binds to a different port; check the toggle's subtitle in
  Developer options. Some firmware requires the TV to be on the same
  subnet as the dev machine - VLAN-isolated IoT networks won't work.
- The TV booted with USB debugging on but network debugging off.
  Re-toggle both, or `adb tcpip 5555` over USB once and then `adb
  connect <ip>:5555` over the network.
- The RSA fingerprint dialog timed out unaccepted. Reconnect; it will
  re-prompt.

### "Build fails with 'SDK location not found'"

- Set `ANDROID_HOME` in your shell rc (`export ANDROID_HOME="$HOME/Library/Android/sdk"`
  on macOS) or add `sdk.dir=/path/to/sdk` to `android-tv/local.properties`.

### "App installs but launches the wrong activity"

- Multiple activities are exported. Only `MainActivity` should be in the
  manifest. `jb-tv launch` explicitly targets `.MainActivity` to avoid
  the launcher picking randomly.
