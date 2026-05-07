// perfMode detects whether the kid client is running on a snappy
// device or a slow one and stamps `body[data-perf="slow"|"fast"]`
// accordingly. CSS rules + JS animators read this stamp to scale
// their durations / ease constants - on a cheap Android TV the
// 200ms animations that feel slick on a desktop browser become
// stutter-y, so the slow profile cuts those roughly in half.
//
// Two-stage detection:
//   1. Initial heuristic from navigator.deviceMemory +
//      hardwareConcurrency. Cheap APIs, gives us a starting guess
//      before any frames have rendered.
//   2. Live FPS sample over the first 1500ms. Counts rAF callbacks
//      to compute observed FPS; if under 50, we override to slow.
//      The user-perceptible "choppy" threshold is around 45-50 FPS
//      on a 60Hz panel.
//
// Snapshot value from getPerfMode() at module-load time is fine for
// callers who only need a "static" verdict (e.g. set animation ease
// once). For long-lived components that should track changes, read
// `document.body.dataset.perf` directly each frame.

export type PerfMode = "fast" | "slow";

function heuristicMode(): PerfMode {
    const w = window as unknown as {
        navigator: Navigator & { deviceMemory?: number };
    };
    const mem = w.navigator.deviceMemory ?? 8;
    const cores = w.navigator.hardwareConcurrency ?? 4;
    if (mem <= 2 || cores <= 2) return "slow";
    return "fast";
}

export function getPerfMode(): PerfMode {
    if (typeof document === "undefined") return "fast";
    const stamp = document.body?.dataset.perf;
    if (stamp === "slow" || stamp === "fast") return stamp;
    return heuristicMode();
}

// startPerfMonitor stamps body[data-perf] from the heuristic
// immediately, then refines after a short rAF-based FPS sample.
// Call once at app boot.
export function startPerfMonitor(): void {
    if (typeof document === "undefined") return;
    const initial = heuristicMode();
    document.body.dataset.perf = initial;

    // FPS sample. Skip the first ~200ms of frames - bundle parse +
    // first paint stutter doesn't represent steady-state behavior.
    const sampleStart = performance.now() + 200;
    const sampleEnd = sampleStart + 1500;
    let frames = 0;
    let started = false;
    function step(now: number) {
        if (now >= sampleStart) {
            if (!started) {
                started = true;
                frames = 0;
            }
            frames++;
        }
        if (now < sampleEnd) {
            requestAnimationFrame(step);
            return;
        }
        const elapsed = sampleEnd - sampleStart;
        const fps = (frames / elapsed) * 1000;
        const measured: PerfMode = fps < 50 ? "slow" : "fast";
        document.body.dataset.perf = measured;
        // eslint-disable-next-line no-console
        console.log(
            `[perf] fps=${fps.toFixed(1)} initial=${initial} measured=${measured}`,
        );
    }
    requestAnimationFrame(step);
}
