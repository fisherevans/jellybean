import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { getSession, hydrateAuthFromBridge } from "./auth";
import { refreshKidsConfig } from "./kidsConfig";
import { startPerfMonitor } from "./perfMode";
import { startPerfOverlay } from "./perfOverlay";
import Browse from "./Browse";
import KidOverlays from "./KidOverlays";
import KidsHome from "./KidsHome";
import Library from "./Library";
import Login from "./Login";
import Play from "./Play";
import TagDetail from "./TagDetail";
import Tags from "./Tags";
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
                <Route element={<KidsHome />}>
                    <Route path="/browse" element={<Browse />} />
                    <Route path="/library" element={<Library />} />
                    <Route path="/tags" element={<Tags />} />
                </Route>
                <Route path="/tags/:tagId" element={<TagDetail />} />
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

// Fetch the client runtime config once, after auth is (re)hydrated so
// the request carries kid bearer auth. Fire-and-forget: it caches to
// localStorage on success and fails soft (offline / 401 / signed-out)
// so it never blocks boot. P1 plumbing (jellybean#107) - not yet wired
// into streaming. No-op when signed out; Login triggers it on sign-in
// paths later (P2).
void refreshKidsConfig();

// Stamp body[data-perf] from device heuristics + a brief FPS
// sample. CSS + JS animators scale their timings against this so
// slow Android TVs get snappier (shorter) transitions while fast
// devices keep the polished defaults.
startPerfMonitor();

// Live perf overlay (FPS + long-task readout + LoAF + JS heap).
// Off by default; toggle from the kid Menu ("Turn on perf
// overlay") which writes the localStorage flag below and reloads.
// Useful while diagnosing perf regressions on the TV.
if (localStorage.getItem("jellybean.kids.perfDebug") === "1") {
    startPerfOverlay();
}

// Per-tab random vertical offsets for the rainbow bg are now
// owned by KidsHome - each tab gets its own offset, generated
// lazily on first visit. See KidsHome.tsx.

ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <BrowserRouter basename="/player">
            <AppShell />
        </BrowserRouter>
    </React.StrictMode>,
);

// Hold the splash until ALL of:
//   1. React has mounted + completed its first commit (two rAFs).
//   2. The browse page's SVG bg tile has loaded into cache.
//   3. The first kid page (Browse / Library / Login) has rendered
//      its real content - signalled via a `jellybean:ready` event
//      the page dispatches once `data !== null` (or it's a no-data
//      page like Login). Without this, the splash would hide
//      while Browse was still showing its "Loading..." state and
//      the kid saw an extra unstyled flash.
//   4. A small grace tick so the browser has a frame to actually
//      paint the loaded content before the splash crossfades.
//
// Cap the wait at 2s so a slow network on the initial /api/kids/browse
// fetch doesn't strand the kid on a forever-splash; if data isn't
// ready by then, hide the splash anyway and let the page's own
// loading state take over.
const SPLASH_MAX_MS = 2000;
function hideSplash() {
    const splash = document.getElementById("splash");
    if (!splash || splash.classList.contains("hidden")) return;
    splash.classList.add("hidden");
    // Drop it from the DOM after the transition so it can't trap
    // focus or eat input on cheap TVs that still respect display:none
    // semantics during opacity transitions.
    setTimeout(() => splash.remove(), 600);
}

const bgPreload = new Promise<void>((resolve) => {
    const img = new Image();
    img.onload = () => resolve();
    img.onerror = () => resolve();
    img.src = "/player/browse-bg-tile.svg";
});

const reactMounted = new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
});

const pageReady = new Promise<void>((resolve) => {
    const onReady = () => {
        window.removeEventListener("jellybean:ready", onReady);
        resolve();
    };
    window.addEventListener("jellybean:ready", onReady);
});

const timeoutCap = new Promise<void>((resolve) =>
    setTimeout(resolve, SPLASH_MAX_MS),
);

Promise.race([
    Promise.all([bgPreload, reactMounted, pageReady]).then(() => undefined),
    timeoutCap,
]).then(() => {
    // Two more rAFs so the bg image + tile content have frames to
    // actually paint before the splash crossfades out.
    requestAnimationFrame(() =>
        requestAnimationFrame(hideSplash),
    );
});
