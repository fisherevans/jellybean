// perfOverlay renders a small live diagnostics panel in the
// top-right of the screen. Three things on the screen at a time:
//   - FPS, sampled rolling-average over the last 500ms
//   - Longest "long task" (>50ms blocking work) seen in the last
//     2 seconds, via PerformanceObserver
//   - JS heap usage when available (Chromium-only API)
//
// The overlay is plain DOM, drawn via rAF so it doesn't trigger
// React work. It's purely additive - no impact on rendering when
// closed (unmount removes it cleanly).
//
// Toggle visibility with Ctrl+P. On boot it's visible so you can
// see what the kid TV is doing without hunting for a hotkey.

type LongTask = { duration: number; ts: number; name: string };

const ID = "perf-overlay";
// Long-task readout sticks for 5s so a blocking spike is readable
// even when the kid only causes one between scrolls.
const LONG_TASK_WINDOW_MS = 5000;

export function startPerfOverlay(): () => void {
    if (typeof document === "undefined") return () => {};

    const el = document.createElement("div");
    el.id = ID;
    Object.assign(el.style, {
        position: "fixed",
        top: "8px",
        right: "8px",
        zIndex: "9999",
        background: "rgba(0,0,0,0.78)",
        color: "#cfd8ff",
        font: "11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace",
        padding: "6px 10px",
        borderRadius: "8px",
        pointerEvents: "none",
        whiteSpace: "pre",
        textAlign: "right",
        letterSpacing: "0.02em",
    });
    document.body.appendChild(el);

    const longTasks: LongTask[] = [];
    let frames = 0;
    let lastFpsTs = performance.now();
    let fps = 0;
    let stopped = false;

    let peakBlockMs = 0;
    let observer: PerformanceObserver | null = null;
    try {
        observer = new PerformanceObserver((list) => {
            const now = performance.now();
            for (const entry of list.getEntries()) {
                const duration = entry.duration;
                longTasks.push({ duration, ts: now, name: entry.name });
                if (duration > peakBlockMs) peakBlockMs = duration;
                if (duration >= 100) {
                    // eslint-disable-next-line no-console
                    console.warn(
                        `[perf] long task ${duration.toFixed(0)}ms ` +
                            `name="${entry.name}" type="${entry.entryType}"`,
                        entry,
                    );
                }
            }
            const cutoff = now - LONG_TASK_WINDOW_MS;
            while (longTasks.length > 0 && longTasks[0].ts < cutoff) {
                longTasks.shift();
            }
        });
        observer.observe({ entryTypes: ["longtask"] });
    } catch {
        // longtask not available in some WebView builds. Silently skip.
    }

    // Long-animation-frame (LoAF) observer. Newer than longtask -
    // breaks each slow frame into the chunks that produced it:
    // blockingDuration (input-blocking), styleAndLayoutDuration,
    // renderStart vs startTime (painting), and scripts[] with each
    // script's source URL + duration + invoker (event listener,
    // promise, microtask, etc). Far more signal than longtask's
    // "self" attribution. Available on Chrome/WebView 123+.
    try {
        const loafObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries() as PerformanceEntry[]) {
                const e = entry as PerformanceEntry & {
                    blockingDuration?: number;
                    renderStart?: number;
                    styleAndLayoutStart?: number;
                    scripts?: Array<{
                        name?: string;
                        sourceURL?: string;
                        duration?: number;
                        invoker?: string;
                        invokerType?: string;
                        forcedStyleAndLayoutDuration?: number;
                    }>;
                };
                if (e.duration < 100) continue;
                const blocking = e.blockingDuration ?? 0;
                const styleLayout =
                    e.renderStart && e.styleAndLayoutStart
                        ? e.renderStart - e.styleAndLayoutStart
                        : 0;
                const renderEnd = e.startTime + e.duration;
                const renderMs = e.renderStart ? renderEnd - e.renderStart : 0;
                const scriptCount = e.scripts?.length ?? 0;
                const topScripts = (e.scripts ?? [])
                    .slice()
                    .sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))
                    .slice(0, 3)
                    .map(
                        (s) =>
                            `${(s.duration ?? 0).toFixed(0)}ms ` +
                            `${s.invokerType ?? "?"}:${s.invoker ?? "?"} ` +
                            `(forcedLayout=${(s.forcedStyleAndLayoutDuration ?? 0).toFixed(0)}ms)`,
                    );
                // eslint-disable-next-line no-console
                console.warn(
                    `[loaf] ${e.duration.toFixed(0)}ms ` +
                        `blocking=${blocking.toFixed(0)} ` +
                        `style+layout=${styleLayout.toFixed(0)} ` +
                        `render=${renderMs.toFixed(0)} ` +
                        `scripts=${scriptCount}`,
                    { entry: e, topScripts },
                );
            }
        });
        loafObserver.observe({ type: "long-animation-frame", buffered: true });
    } catch {
        // LoAF not available - older WebView. Quietly skip.
    }

    function format(): string {
        const lines: string[] = [];
        lines.push(`FPS  ${fps.toFixed(1).padStart(5)}`);
        const now = performance.now();
        const recent = longTasks.filter((t) => t.ts >= now - LONG_TASK_WINDOW_MS);
        if (recent.length > 0) {
            const longest = recent.reduce(
                (a, b) => (b.duration > a.duration ? b : a),
            );
            lines.push(
                `BLK ${longest.duration.toFixed(0).padStart(4)}ms ×${recent.length}`,
            );
        } else {
            lines.push(`BLK    --`);
        }
        // Peak = highest blocking task seen since boot. Sticks so
        // you can confirm the worst spike even after the rolling
        // window expires.
        lines.push(`PEAK ${peakBlockMs.toFixed(0).padStart(4)}ms`);
        const mem = (performance as Performance & {
            memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
        }).memory;
        if (mem) {
            const usedMb = (mem.usedJSHeapSize / 1024 / 1024).toFixed(0);
            const limitMb = (mem.jsHeapSizeLimit / 1024 / 1024).toFixed(0);
            lines.push(`MEM ${usedMb.padStart(3)}/${limitMb}MB`);
        }
        const perf = document.body.dataset.perf ?? "?";
        lines.push(`MODE ${perf}`);
        return lines.join("\n");
    }

    function tick(now: number) {
        if (stopped) return;
        frames++;
        const elapsed = now - lastFpsTs;
        if (elapsed >= 500) {
            fps = (frames * 1000) / elapsed;
            frames = 0;
            lastFpsTs = now;
            el.textContent = format();
        }
        requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);

    function onKey(e: KeyboardEvent) {
        if (e.ctrlKey && e.key === "p") {
            e.preventDefault();
            el.style.display = el.style.display === "none" ? "" : "none";
        }
    }
    window.addEventListener("keydown", onKey);

    return () => {
        stopped = true;
        observer?.disconnect();
        window.removeEventListener("keydown", onKey);
        el.remove();
    };
}
