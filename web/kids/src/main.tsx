import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { getSession, hydrateAuthFromBridge } from "./auth";
import { startPerfMonitor } from "./perfMode";
import Browse from "./Browse";
import KidOverlays from "./KidOverlays";
import Library from "./Library";
import Login from "./Login";
import Play from "./Play";
import Watch from "./Watch";
import { prefetchLibrary } from "./prefetch";
import "./styles.css";

// Index gates the / route: signed-in users land at /library, everyone
// else gets bounced to /login. Library itself runs the same check (so
// deep links don't bypass it), but doing it here keeps the initial
// render free of a flicker through the library shell.
//
// Side effect: when we know we're about to navigate the user to
// /library, kick off a background prefetch so the cache is warm by the
// time Library mounts. Fire-and-forget; the prefetch module gates
// duplicates internally.
function Index() {
    const signedIn = !!getSession();
    if (signedIn) prefetchLibrary();
    // M8: Browse is the kid's home. Library is still reachable via
    // the tab pill at the top of either page.
    return <Navigate to={signedIn ? "/browse" : "/login"} replace />;
}

// AppShell wraps the routed page in the cross-cutting kid overlay
// surface (lockout, body break, viewing filter, mode theme). The
// overlays poll their server endpoints internally and render only
// when their respective conditions fire. activelyPlaying tells the
// body-break poll to use a faster cadence on /play.
function AppShell() {
    const location = useLocation();
    const onPlay = location.pathname.startsWith("/play");
    return (
        <>
            <Routes>
                <Route path="/" element={<Index />} />
                <Route path="/login" element={<Login />} />
                <Route path="/browse" element={<Browse />} />
                <Route path="/library" element={<Library />} />
                <Route path="/watch/:itemId" element={<Watch />} />
                <Route path="/play/:itemId" element={<Play />} />
                <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            <KidOverlays activelyPlaying={onPlay} />
        </>
    );
}

// Disable the browser's automatic scroll restoration so popstate
// (used by useProgressiveBack's sentinel pattern) doesn't snap the
// page back to where the kid was scrolled - we manage scroll
// position ourselves via the focus effects.
if ("scrollRestoration" in window.history) {
    window.history.scrollRestoration = "manual";
}

// Desktop-keyboard parity for the Android remote. Two pieces:
//   1. preventDefault on arrow keys app-wide (capture phase) so the
//      browser never scrolls the page in response. Per-page handlers
//      already do this, but a window listener at capture phase is the
//      defense-in-depth: race conditions between mount and a fast
//      keypress can otherwise let one or two arrows slip through and
//      scroll the page.
//   2. Backspace fires the back handler. Chrome stopped mapping
//      Backspace to history.back years ago; without this shim, the
//      key does nothing in the kid app on desktop. The Android
//      remote BACK is intercepted at the Activity layer
//      (window.__jellybeanBack) and never reaches keydown, so this
//      desktop shim doesn't double-fire there.
//
// Skip when an input/textarea/contenteditable is focused (no such
// elements in the kid client today, but a search field could land
// here later).
window.addEventListener(
    "keydown",
    (e) => {
        const target = e.target as HTMLElement | null;
        const isTextInput =
            target &&
            (target.tagName === "INPUT" ||
                target.tagName === "TEXTAREA" ||
                target.isContentEditable);
        if (isTextInput) return;
        if (
            e.key === "ArrowUp" ||
            e.key === "ArrowDown" ||
            e.key === "ArrowLeft" ||
            e.key === "ArrowRight"
        ) {
            e.preventDefault();
            return;
        }
        if (e.key === "Backspace") {
            const onShell = typeof (
                window as unknown as { JellybeanShell?: unknown }
            ).JellybeanShell !== "undefined";
            if (onShell) return; // Activity owns BACK on Android
            e.preventDefault();
            const handler = window.__jellybeanBack;
            if (handler && handler()) return;
            // No page handler consumed it - fall through to history.
            window.history.back();
        }
    },
    { capture: true },
);

// Replay the kid auth blob from Android SharedPreferences back into
// localStorage when localStorage is empty but the bridge has a blob
// (i.e. WebView storage was pruned but the APK still has the
// session). Synchronous JNI call - React's first render below sees
// the rehydrated localStorage. No-op in browser.
hydrateAuthFromBridge();

// Stamp body[data-perf] from device heuristics + a brief FPS
// sample. CSS + JS animators scale their timings against this so
// slow Android TVs get snappier (shorter) transitions while fast
// devices keep the polished defaults.
startPerfMonitor();

ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <BrowserRouter basename="/player">
            <AppShell />
        </BrowserRouter>
    </React.StrictMode>,
);

// Fade out the splash once React has mounted. Two rAFs give the browser
// time to paint the first frame so the transition starts from a stable
// state rather than racing the initial commit.
requestAnimationFrame(() => {
    requestAnimationFrame(() => {
        const splash = document.getElementById("splash");
        if (!splash) return;
        splash.classList.add("hidden");
        // Drop it from the DOM after the transition so it can't trap
        // focus or eat input on cheap TVs that still respect display:none
        // semantics during opacity transitions.
        setTimeout(() => splash.remove(), 600);
    });
});
