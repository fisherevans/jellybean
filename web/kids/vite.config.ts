import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// The kids app is served by the Go binary at /player, so all asset URLs
// need to be /player-prefixed. base: "/player/" handles that for both
// dev and prod.
export default defineConfig({
    plugins: [
        react(),
        // Offline service worker (jellybean#107 P1). Scope: static shell
        // + hashed assets, plus ONE deliberate /api exception for poster
        // art (see the kids-poster-art runtime route below). It caches no
        // other /api/* path - catalog JSON stays network-first via the
        // in-app IDB + ETag SWR layer, so we never risk serving stale
        // curation data from the SW.
        //
        // Strategy:
        //   - Precache the hashed /assets/* (content-addressed, immutable)
        //     so JS/CSS load with no network once installed.
        //   - index.html / navigations: NetworkFirst with a short timeout,
        //     falling back to the cached shell. A fresh deploy (new asset
        //     hashes) is picked up on the very next reload while the backend
        //     is up; a backend-down load falls back to the last cached shell
        //     instead of the browser's offline error page.
        //   - /api/* is explicitly excluded from navigation handling and
        //     matches no runtime route, so it always hits the network.
        //
        // Lifecycle: registerType 'autoUpdate' => skipWaiting + clientsClaim.
        // A reload after a new build activates the new SW immediately and the
        // injected registration auto-reloads once so kids are never stranded
        // on a stale shell. This is what keeps the rsync-mounted dev loop and
        // server-side hotfixes working: reload always converges on the newest
        // build without a manual hard-refresh.
        //
        // devOptions.enabled: false keeps the SW out of `npm run dev` (Vite
        // dev server) - it only ships in production builds.
        VitePWA({
            registerType: "autoUpdate",
            injectRegister: "auto",
            // Not an installable PWA - this is a TV WebView shell cache, not a
            // home-screen app. Skip the web app manifest (and its icon set).
            manifest: false,
            devOptions: {
                enabled: false,
            },
            workbox: {
                // Precache hashed assets only. index.html is deliberately NOT
                // precached - it's served NetworkFirst below so deploys land
                // on reload without waiting for a second SW-update cycle.
                globPatterns: ["assets/**/*.{js,css,woff,woff2}"],
                // Disable vite-plugin-pwa's default cache-first NavigationRoute
                // (it binds to a precached "index.html" we intentionally don't
                // precache, and it registers ahead of our route, swallowing
                // every navigation). With it off, the NetworkFirst route below
                // owns navigations - network-first for freshness, cached shell
                // as the offline fallback.
                navigateFallback: null,
                runtimeCaching: [
                    {
                        // App shell HTML. NetworkFirst so a fresh deploy is
                        // picked up on reload; the cached copy is the offline
                        // fallback when the backend is down.
                        urlPattern: ({ request, url }) =>
                            request.mode === "navigate" &&
                            !url.pathname.startsWith("/api/"),
                        handler: "NetworkFirst",
                        options: {
                            cacheName: "kids-shell",
                            networkTimeoutSeconds: 3,
                            cacheableResponse: { statuses: [0, 200] },
                            expiration: { maxEntries: 16 },
                        },
                    },
                    {
                        // DELIBERATE EXCEPTION to "the SW never caches /api"
                        // (jellybean#107 P1 - offline poster art). Item images
                        // are proxied same-origin at
                        // /api/kids/items/{id}/image?type=...&tag=...  and are
                        // effectively immutable per item + imageTag (the tag
                        // rotates in the URL when Jellyfin regenerates art), so
                        // CacheFirst is safe: a hit never needs revalidation and
                        // stale poster art offline is fine. This lets the
                        // durable IDB catalog (Browse/Tags/Library) render WITH
                        // its posters when the backend is unreachable, instead
                        // of a wall of broken images.
                        //
                        // Scope is intentionally narrow: ONLY the image
                        // endpoint. No other /api/* path matches any runtime
                        // route, so catalog JSON etc. still always hit the
                        // network (freshness matters there; that's what the IDB
                        // + ETag SWR layer handles).
                        urlPattern: /\/api\/kids\/items\/.*\/image/,
                        handler: "CacheFirst",
                        options: {
                            cacheName: "kids-poster-art",
                            cacheableResponse: { statuses: [0, 200] },
                            expiration: {
                                maxEntries: 300,
                                maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days
                            },
                        },
                    },
                ],
            },
        }),
    ],
    base: "/player/",
    server: {
        port: 5174,
        proxy: {
            "/api": "http://localhost:8080",
        },
    },
    build: {
        outDir: "dist",
        emptyOutDir: true,
    },
});
