package com.fisherevans.jellybean

import android.annotation.SuppressLint
import android.graphics.Color
import android.os.Bundle
import android.view.KeyEvent
import android.view.WindowManager
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

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Edge-to-edge: draw under the system bars so immersive mode has
        // something to hide.
        WindowCompat.setDecorFitsSystemWindows(window, false)

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
        } else {
            webView.loadUrl(BuildConfig.JELLYBEAN_URL)
        }

        webView.requestFocus()
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
     * BACK navigates the WebView's history first; falls through to the
     * default behaviour (which finishes the Activity) when there is no
     * history left. D-pad keys are deliberately left to the default path
     * so the focused WebView receives them as `keydown` events.
     */
    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView.canGoBack()) {
            webView.goBack()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }
}
