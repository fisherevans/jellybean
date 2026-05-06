package com.fisherevans.jellybean

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.KeyEvent
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * Single-Activity WebView shell for the Jellybean kids client.
 *
 * The WebView is the entire Activity. Everything D-pad / focus related is
 * handled by the kids SPA itself - Android delivers DPAD_UP / DOWN / LEFT
 * / RIGHT / CENTER to the focused View by default, and a focused WebView
 * forwards those as `keydown` events to the embedded page. The Activity
 * only intervenes for BACK so the web app's back-stack works the way users
 * expect on TV.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    /**
     * App-private SharedPreferences file holding a single "blob" key
     * with the kid's serialized auth state (token, userId, deviceId,
     * etc.). Mirrored from the JS side via the JellybeanShell bridge
     * so the kid stays signed in across WebView localStorage prunes
     * (Android's storage-cleanup, WebView upgrades, etc).
     *
     * Dedicated file (not the default activity prefs) so a future
     * "wipe auth" tool can delete just this file without touching
     * unrelated state.
     */
    private lateinit var authPrefs: SharedPreferences

    companion object {
        private const val AUTH_PREFS_FILE = "jellybean_kids_auth"
        private const val AUTH_PREFS_BLOB = "blob"

        /**
         * Dev intent that wipes the kid's auth state and (optionally)
         * pre-fills the sign-in form with username/password so a
         * subsequent test session doesn't require typing on the TV
         * remote. Trigger from a workstation:
         *
         *   adb shell am start \
         *     -n com.fisherevans.jellybean.debug/com.fisherevans.jellybean.MainActivity \
         *     -a com.fisherevans.jellybean.action.DEV_LOGIN \
         *     --es username "kids" --es password "kids1234"
         *
         * Without `username`/`password` extras, just clears auth and
         * lands on the login screen. Gated on BuildConfig.DEBUG so a
         * release APK ignores the action even if it's invoked.
         *
         * Creds are passed in the URL fragment (window.location.hash)
         * which is never sent in network requests; it lives in the
         * WebView's history briefly until Login.tsx consumes it.
         */
        private const val ACTION_DEV_LOGIN = "com.fisherevans.jellybean.action.DEV_LOGIN"
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Initialize the auth-mirroring prefs early so handleDevIntent +
        // the JellybeanShell bridge methods can both rely on it being set.
        authPrefs = getSharedPreferences(AUTH_PREFS_FILE, Context.MODE_PRIVATE)

        // Edge-to-edge: draw under the system bars so immersive mode has
        // something to hide.
        WindowCompat.setDecorFitsSystemWindows(window, false)

        // Expose this WebView to chrome://inspect for remote debugging.
        // Required for `adb forward tcp:9222 localabstract:chrome_devtools_remote`
        // to actually find a target. Gate on the debug build flag so
        // release APKs (when we cut one) don't expose internals.
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        webView = WebView(this).apply {
            setBackgroundColor(Color.BLACK)
            // Required for the SPA to receive D-pad keydowns. WebView is
            // focusable by default but explicit is clearer.
            isFocusable = true
            isFocusableInTouchMode = true
        }
        setContentView(webView)

        configureWebView(webView)
        enterImmersiveMode()

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState)
        } else if (intent?.action != ACTION_DEV_LOGIN) {
            webView.loadUrl(BuildConfig.JELLYBEAN_URL)
        }
        // For DEV_LOGIN cold starts, handleDevIntent below issues the
        // load to /player/login (with optional creds in the hash).

        webView.requestFocus()
        handleDevIntent(intent, coldStart = true)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleDevIntent(intent, coldStart = false)
    }

    /**
     * Reset auth + (optionally) pre-fill the login form. Cold start: we
     * skip the initial loadUrl and jump straight to /player/login here.
     * Warm start: we navigate the existing WebView there. Either way,
     * the kid auth localStorage keys get wiped via JS first so the
     * Login component doesn't bounce a still-signed-in user back to
     * /browse before reading the dev creds from the hash.
     */
    private fun handleDevIntent(intent: Intent?, coldStart: Boolean) {
        if (intent == null || intent.action != ACTION_DEV_LOGIN) return
        if (!BuildConfig.DEBUG) return
        val username = intent.getStringExtra("username")
        val password = intent.getStringExtra("password")

        // Strip path off BuildConfig.JELLYBEAN_URL to get the origin -
        // we always navigate to /player/login regardless of where the
        // base URL points (e.g. some dev configs ship /player/ path).
        val baseUri = Uri.parse(BuildConfig.JELLYBEAN_URL)
        val origin = "${baseUri.scheme}://${baseUri.authority}"
        val target = StringBuilder("$origin/player/login")
        if (!username.isNullOrEmpty() && !password.isNullOrEmpty()) {
            target.append("#dev_user=").append(Uri.encode(username))
            target.append("&dev_pass=").append(Uri.encode(password))
        }
        val targetUrl = target.toString()

        // Always clear the SharedPreferences mirror so the next
        // hydrateAuthFromBridge() at app boot doesn't replay a stale
        // session before Login can consume the dev creds. Symmetric
        // with the JS clearSession() flow on the warm-start branch.
        authPrefs.edit().remove(AUTH_PREFS_BLOB).apply()

        // localStorage clear runs in JS. On cold start the WebView
        // doesn't have a loaded page yet so evaluateJavascript would be
        // a no-op - just loadUrl directly and let Login.tsx clear the
        // session synchronously when it consumes the hash. On warm
        // start, clear first so the Login component's signed-in
        // redirect doesn't bounce to /browse before reading the hash.
        if (coldStart) {
            webView.loadUrl(targetUrl)
            return
        }
        // Prefix-scan removal mirrors clearSession()'s policy: every
        // jellybean.kids.* key except deviceId (the per-install
        // identity outlives sign-in cycles). Hardcoding the key list
        // would silently miss new fields - see kidId, which the
        // earlier explicit list omitted.
        val js = """
            try {
                var toRemove = [];
                for (var i = 0; i < localStorage.length; i++) {
                    var k = localStorage.key(i);
                    if (k && k.indexOf('jellybean.kids.') === 0
                        && k !== 'jellybean.kids.deviceId') {
                        toRemove.push(k);
                    }
                }
                for (var j = 0; j < toRemove.length; j++) {
                    localStorage.removeItem(toRemove[j]);
                }
            } catch(e){}
        """.trimIndent()
        webView.evaluateJavascript(js) {
            runOnUiThread { webView.loadUrl(targetUrl) }
        }
    }

    private fun configureWebView(wv: WebView) {
        val s: WebSettings = wv.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        // Required for IndexedDB / Cache API used by the M4 cache layer.
        s.databaseEnabled = true
        s.mediaPlaybackRequiresUserGesture = false
        s.loadWithOverviewMode = true
        s.useWideViewPort = true
        s.cacheMode = WebSettings.LOAD_DEFAULT
        // Defensive: same-origin in production, but lets the dev cleartext
        // setup load mixed assets without surprises. minSdk is 21 so this
        // setting is always available.
        s.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE

        // Keep navigations inside the WebView. Without this, link clicks
        // can punt out to the system browser.
        wv.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest
            ): Boolean {
                view.loadUrl(request.url.toString())
                return true
            }
        }

        // Surface fullscreen video requests (HLS) to the system. The
        // default WebChromeClient handles enter/exit fullscreen well enough
        // for video playback inside the WebView.
        wv.webChromeClient = WebChromeClient()

        // Expose a tiny JS bridge for the kid client's "Reset Player"
        // recovery action. The web side calls
        // `window.JellybeanShell.recreateActivity()` from the player's
        // error screen when hls.js's recovery ladder has been exhausted
        // and the underlying WebView decoder is wedged. recreate() tears
        // down the Activity (and the WebView with it) and brings up a
        // fresh one - the cleanest way to reset the OS-level decoder
        // pool on cheap Android TVs that don't recover otherwise.
        wv.addJavascriptInterface(JellybeanShell(), "JellybeanShell")
    }

    /**
     * JS bridge surface. Methods here run on a background thread (the
     * WebView's JS thread); marshal back to the UI thread for anything
     * Activity-related.
     *
     * Annotated `@JavascriptInterface` per Android's API 17+ contract;
     * any new method needs the annotation or it won't be callable from
     * JS. Keep this surface as small as possible and document each
     * method - random methods on `this` would otherwise be reachable.
     */
    private inner class JellybeanShell {
        @JavascriptInterface
        fun recreateActivity() {
            runOnUiThread { recreate() }
        }

        /**
         * Tear the activity down so the launcher takes over. Used by the
         * kid client's Menu -> Exit. finishAndRemoveTask() drops the task
         * from the recents list so a casual relaunch is a clean cold start.
         */
        @JavascriptInterface
        fun exitApp() {
            runOnUiThread { finishAndRemoveTask() }
        }

        /**
         * Mirror the kid auth state from JS -> SharedPreferences. The
         * kid SPA calls this from setSession() so the auth blob
         * survives WebView localStorage prunes. Storage is opaque
         * JSON; JS owns the schema. Single key = single atomic write,
         * no per-field bookkeeping in Kotlin.
         */
        @JavascriptInterface
        fun setAuthBlob(json: String) {
            authPrefs.edit().putString(AUTH_PREFS_BLOB, json).apply()
        }

        /**
         * Read the kid auth blob, or null when not set. Called once
         * at boot from hydrateAuthFromBridge() in main.tsx so the
         * SPA can replay the blob into localStorage if WebView
         * storage was pruned. Returns String? - JS sees null as
         * native null.
         */
        @JavascriptInterface
        fun getAuthBlob(): String? {
            return authPrefs.getString(AUTH_PREFS_BLOB, null)
        }

        /**
         * Drop the kid auth blob. Called from clearSession() (kid
         * tap-Sign-Out) so the next launch starts at /login.
         */
        @JavascriptInterface
        fun clearAuthBlob() {
            authPrefs.edit().remove(AUTH_PREFS_BLOB).apply()
        }
    }

    private fun enterImmersiveMode() {
        // Hide both the status bar and the nav bar; let the user swipe to
        // reveal them transiently. On TVs there is no status/nav bar to
        // begin with, but this is the clean way to express "fullscreen"
        // and it makes phone/tablet sideloads behave during development.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.hide(WindowInsetsCompat.Type.systemBars())
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) enterImmersiveMode()
    }

    override fun onPause() {
        super.onPause()
        webView.onPause()
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onDestroy() {
        // Detach + destroy in this order to avoid the documented WebView
        // leak on Activity teardown.
        (webView.parent as? android.view.ViewGroup)?.removeView(webView)
        webView.destroy()
        super.onDestroy()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    /**
     * BACK is forwarded to JS first so the kid client's progressive
     * back model (close modals -> reset focus to home -> nav to
     * parent route) can run before any WebView-level history pop.
     * If JS reports it didn't handle (`window.__jellybeanBack`
     * returns false or is absent), we fall back to the default:
     * webView.goBack() if there is history, else finish() to exit.
     *
     * D-pad keys are deliberately left to the default path so the
     * focused WebView receives them as `keydown` events.
     */
    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            webView.evaluateJavascript(
                "(typeof window.__jellybeanBack === 'function' " +
                    "? window.__jellybeanBack() : false)"
            ) { result ->
                runOnUiThread {
                    val handled = result == "true"
                    if (!handled) {
                        if (webView.canGoBack()) webView.goBack()
                        else finish()
                    }
                }
            }
            return true
        }
        return super.onKeyDown(keyCode, event)
    }
}
