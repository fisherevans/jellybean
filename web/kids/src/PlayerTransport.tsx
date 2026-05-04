import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

// PlayerTransport is the kid-friendly video transport. Modeled on
// Netflix's player but stripped down to the actions a kid on a TV remote
// or touch screen actually uses. See issue #33 for the full spec.
//
// Design notes:
//
//   - The component subscribes directly to the underlying <video> element
//     via the supplied ref. State derived from `timeupdate` (current
//     position, scrubber thumb position, time label) is updated
//     imperatively through DOM refs on a 250ms interval. React state is
//     reserved for things that change on a human cadence (visibility,
//     focus region, paused / not, duration). This keeps `timeupdate` -
//     which fires up to 4 times per second - off the React render path.
//
//   - Two focus regions: "scrubber" and "buttons". Up from buttons goes
//     to scrubber; down from scrubber goes to buttons. Left/right on
//     buttons moves between them; left/right on the scrubber seeks 15s.
//     Initial focus on open is the play/pause button (the most common
//     kid action).
//
//   - Auto-hide: hidden during playback, visible during pause, shown on
//     any input (key, mouse, touch) with a 3s idle timer. The first
//     press while hidden is consumed - it only reveals the transport,
//     it does not activate. Subsequent presses act normally. This
//     mirrors Netflix's behavior on TVs.
//
//   - Pointer events power scrubber drag; the same code path handles
//     touch and mouse without a separate branch.

type PlayerTransportProps = {
    videoRef: React.RefObject<HTMLVideoElement | null>;
    onRestart: () => void;
    onNextEpisode?: () => void;
    // Emitted whenever the transport's internal visibility flips. The
    // parent uses this to slide the title header in/out alongside the
    // bottom transport so they share one show/hide motion.
    onVisibleChange?: (visible: boolean) => void;
};

type FocusState =
    | { kind: "scrubber" }
    | { kind: "button"; index: number };

const HIDE_TIMEOUT_MS = 3000;
const SEEK_STEP_SECONDS = 15;
const TIME_TICK_MS = 250;

type ButtonDef = {
    id: "restart" | "playpause" | "next";
    label: string;
    icon: string; // dynamic for play/pause
    onActivate: () => void;
};

export default function PlayerTransport({
    videoRef,
    onRestart,
    onNextEpisode,
    onVisibleChange,
}: PlayerTransportProps) {
    // High-level UI state. These flip on human-cadence events so they
    // can drive React renders without thrashing.
    //
    // Initial visible=false because at mount the video is "paused" only
    // because it hasn't started yet (buffering). Showing the transport
    // during that period puts a "Play" icon on screen and confuses the
    // kid into thinking they need to press it. Once the first play
    // event fires (hasStarted), the transport behaves normally:
    // visible while paused, auto-hides 3s after resume.
    const [visible, setVisible] = useState(false);
    const [paused, setPaused] = useState(false);
    const [duration, setDuration] = useState(0);
    const hasStartedRef = useRef(false);
    const [focus, setFocus] = useState<FocusState>({
        kind: "button",
        index: 1, // play/pause is the middle button when all 3 exist.
    });

    // Imperative refs for the scrubber. We avoid setState on
    // `timeupdate` to keep the event off the React render path: the
    // <video>'s currentTime is read on a 250ms interval and written
    // straight to the DOM via these refs.
    const fillRef = useRef<HTMLDivElement | null>(null);
    const thumbRef = useRef<HTMLDivElement | null>(null);
    const timeLabelRef = useRef<HTMLSpanElement | null>(null);
    const railRef = useRef<HTMLDivElement | null>(null);

    const hideTimerRef = useRef<number | null>(null);

    // Drag state for pointer-driven scrubbing. While dragging the time
    // tick should not overwrite the user's draft position; the rAF /
    // interval read defers to the dragged position via this ref.
    const draggingRef = useRef(false);

    // Most recent commited currentTime (seconds). Used so left/right
    // hold-to-repeat doesn't accumulate beyond what was just applied.
    const lastSeekTargetRef = useRef<number | null>(null);

    // Reset the auto-hide timer. While paused, the transport stays
    // visible regardless (mirrors Netflix). While playing, schedule a
    // 3s hide.
    const armHideTimer = useCallback(() => {
        if (hideTimerRef.current !== null) {
            window.clearTimeout(hideTimerRef.current);
            hideTimerRef.current = null;
        }
        const v = videoRef.current;
        if (v && !v.paused) {
            hideTimerRef.current = window.setTimeout(() => {
                setVisible(false);
            }, HIDE_TIMEOUT_MS);
        }
    }, [videoRef]);

    // Show the transport in response to user input. Returns true when
    // this call is revealing the transport (i.e. it was hidden; the
    // caller should NOT also act on the input - it was a "wake up"
    // press, not an "activate the focused button" press).
    const showOnInput = useCallback((): boolean => {
        if (!visible) {
            setVisible(true);
            armHideTimer();
            return true;
        }
        armHideTimer();
        return false;
    }, [visible, armHideTimer]);

    // Subscribe to the <video>'s lifecycle events. play / pause /
    // durationchange flip React state; timeupdate is intentionally NOT
    // wired (the 250ms interval covers thumb position).
    useEffect(() => {
        const v = videoRef.current;
        if (!v) return;
        const onPlay = () => {
            // First play event after mount marks the buffering period
            // as over; after this, paused-state -> transport-visible.
            hasStartedRef.current = true;
            setPaused(false);
            armHideTimer();
        };
        const onPause = () => {
            setPaused(true);
            // Don't reveal the transport during the initial buffering
            // period, which fires a pause-like state before play() ever
            // succeeds. Only auto-show on a real user-pause after first
            // playback has begun.
            if (hasStartedRef.current) {
                setVisible(true);
                if (hideTimerRef.current !== null) {
                    window.clearTimeout(hideTimerRef.current);
                    hideTimerRef.current = null;
                }
            }
        };
        const onDurationChange = () => {
            setDuration(isFinite(v.duration) ? v.duration : 0);
        };
        v.addEventListener("play", onPlay);
        v.addEventListener("pause", onPause);
        v.addEventListener("durationchange", onDurationChange);
        // Sync once at mount in case the events already fired.
        setPaused(v.paused);
        if (isFinite(v.duration)) setDuration(v.duration);
        return () => {
            v.removeEventListener("play", onPlay);
            v.removeEventListener("pause", onPause);
            v.removeEventListener("durationchange", onDurationChange);
        };
    }, [videoRef, armHideTimer]);

    // Tick: read currentTime from the video and update the scrubber
    // thumb / fill / time label imperatively. 250ms is roughly what
    // YouTube's web player uses; it's smooth enough at 1080p and avoids
    // doing per-frame work on a slow TV.
    useEffect(() => {
        const v = videoRef.current;
        if (!v) return;
        let raf = 0;
        const tick = () => {
            if (!draggingRef.current) {
                applyScrubberPosition(v.currentTime, v.duration, fillRef, thumbRef);
                applyTimeLabel(v.currentTime, v.duration, timeLabelRef);
            }
        };
        tick();
        const id = window.setInterval(tick, TIME_TICK_MS);
        return () => {
            window.clearInterval(id);
            cancelAnimationFrame(raf);
        };
    }, [videoRef, duration]);

    // Cleanup the hide timer on unmount. We don't auto-arm at mount
    // anymore because the transport starts hidden; reveals come from
    // input handlers + the post-firstplay onPause subscription above.
    useEffect(() => {
        return () => {
            if (hideTimerRef.current !== null) {
                window.clearTimeout(hideTimerRef.current);
            }
        };
    }, []);

    // Emit visibility changes so the parent can sync chrome (e.g. the
    // title header) with our show/hide cycle.
    useEffect(() => {
        onVisibleChange?.(visible);
    }, [visible, onVisibleChange]);

    // Build the action list. "next" is conditional on series context;
    // movies see two buttons (restart, play/pause). The play/pause
    // button index moves accordingly so D-pad math stays right.
    const buttons: ButtonDef[] = [];
    buttons.push({
        id: "restart",
        label: "Restart",
        icon: "⟲", // anticlockwise open circle arrow
        onActivate: () => {
            onRestart();
            armHideTimer();
        },
    });
    buttons.push({
        id: "playpause",
        label: paused ? "Play" : "Pause",
        icon: paused ? "▶" : "⏸", // play / pause
        onActivate: () => {
            const v = videoRef.current;
            if (!v) return;
            if (v.paused) {
                attemptPlay(v);
            } else {
                v.pause();
            }
            armHideTimer();
        },
    });
    if (onNextEpisode) {
        buttons.push({
            id: "next",
            label: "Next",
            icon: "⏭", // skip forward
            onActivate: () => {
                onNextEpisode();
                armHideTimer();
            },
        });
    }

    // Clamp focus index when the button list size changes (e.g. movies
    // -> series transition while paused).
    useEffect(() => {
        if (focus.kind === "button" && focus.index >= buttons.length) {
            setFocus({ kind: "button", index: buttons.length - 1 });
        }
    }, [buttons.length, focus]);

    // Window-level keydown. Owns both D-pad navigation and the legacy
    // keyboard shortcuts (Space/Enter, Arrow seek, MediaPlayPause).
    // Escape is intentionally NOT handled here; Play.tsx handles "back
    // to library" and we don't want to consume Escape if the user
    // didn't bind it through the transport.
    useEffect(() => {
        function seek(deltaSeconds: number) {
            const v = videoRef.current;
            if (!v || !isFinite(v.duration)) return;
            const base = lastSeekTargetRef.current ?? v.currentTime;
            const next = Math.max(0, Math.min(v.duration - 1, base + deltaSeconds));
            v.currentTime = next;
            lastSeekTargetRef.current = next;
            applyScrubberPosition(next, v.duration, fillRef, thumbRef);
            applyTimeLabel(next, v.duration, timeLabelRef);
        }
        function togglePlay() {
            const v = videoRef.current;
            if (!v) return;
            if (v.paused) {
                attemptPlay(v);
            } else {
                v.pause();
            }
        }

        function onKey(e: KeyboardEvent) {
            // TV remotes auto-repeat keydown when the OK button is held
            // even briefly - a single user tap can fire keydown
            // (repeat=false), keydown (repeat=true), keyup within
            // ~50ms. Without this filter, OK toggles play -> pause ->
            // play in rapid succession, causing the audio to stutter
            // and leaving the parity unpredictable. We always want to
            // act on the original keydown only.
            if (e.repeat) return;

            // Escape stays Play.tsx's responsibility (back to library).
            if (e.key === "Escape") return;
            // Don't intercept Backspace / GoBack here. On Android TV
            // the BACK button is delivered to MainActivity.onKeyDown
            // which calls webView.goBack() - the right behavior. If
            // we ALSO call onBack here from JS, both fire and the
            // user has to press BACK twice to actually leave a show.
            // Letting the Activity own the BACK semantics keeps the
            // navigation single-press.

            // Hardware media keys always toggle, regardless of focus.
            if (e.key === "MediaPlayPause") {
                e.preventDefault();
                showOnInput();
                togglePlay();
                return;
            }
            if (e.key === "MediaPlay") {
                videoRef.current?.play().catch(() => {});
                showOnInput();
                return;
            }
            if (e.key === "MediaPause") {
                videoRef.current?.pause();
                showOnInput();
                return;
            }

            const isHandledKey =
                e.key === "ArrowLeft" ||
                e.key === "ArrowRight" ||
                e.key === "ArrowUp" ||
                e.key === "ArrowDown" ||
                e.key === "Enter" ||
                e.key === " ";
            if (!isHandledKey) return;

            // First-press-shows-only: if the transport is hidden, this
            // press just reveals it. Don't also gate on
            // consumeNextPressRef here - that flag exists for the
            // pointer path (a tap that reveals shouldn't also fire a
            // button click). For keyboard, the keydown is atomic;
            // returning early on `consumed` is enough. Reading the
            // flag in the keyboard path caused every press AFTER a
            // reveal to be eaten too, breaking play/pause.
            const consumed = showOnInput();
            if (consumed) {
                // preventDefault unconditionally on the reveal press.
                // Without this, Enter on a focused button would still
                // fire the browser's synthesized onClick AFTER our
                // handler returns - the button mounts + grabs focus
                // during the same press that revealed the transport,
                // and the click follows. Net effect: a single OK tap
                // reveals AND activates the focused button. With
                // preventDefault, the reveal press only reveals.
                e.preventDefault();
                return;
            }

            // preventDefault on every key we own. Two reasons:
            //   1. Arrow keys: stop the page (which is the whole
            //      player) from scrolling behind the transport.
            //   2. Enter / Space: stop the browser's synthesized
            //      click on the focused button. Without this, our
            //      keydown handler activates the button (pause) AND
            //      the synthesized click activates it again (play).
            //      Net effect: pause + play = no-op, kid thinks
            //      pause is broken.
            e.preventDefault();

            // D-pad routing.
            if (focus.kind === "scrubber") {
                if (e.key === "ArrowLeft") {
                    seek(-SEEK_STEP_SECONDS);
                    return;
                }
                if (e.key === "ArrowRight") {
                    seek(SEEK_STEP_SECONDS);
                    return;
                }
                if (e.key === "ArrowDown") {
                    setFocus({ kind: "button", index: 1 < buttons.length ? 1 : 0 });
                    return;
                }
                if (e.key === "ArrowUp") {
                    // No region above; ignore.
                    return;
                }
                if (e.key === "Enter" || e.key === " ") {
                    // OK on scrubber: no-op (the issue spec says seeks
                    // commit live, so OK has nothing left to do).
                    return;
                }
                return;
            }
            // focus.kind === "button"
            if (e.key === "ArrowLeft") {
                setFocus({
                    kind: "button",
                    index: Math.max(0, focus.index - 1),
                });
                return;
            }
            if (e.key === "ArrowRight") {
                setFocus({
                    kind: "button",
                    index: Math.min(buttons.length - 1, focus.index + 1),
                });
                return;
            }
            if (e.key === "ArrowUp") {
                setFocus({ kind: "scrubber" });
                return;
            }
            if (e.key === "ArrowDown") {
                // No region below.
                return;
            }
            if (e.key === "Enter" || e.key === " ") {
                const btn = buttons[focus.index];
                btn?.onActivate();
                return;
            }
        }

        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [focus, buttons, showOnInput, videoRef]);

    // Pointer / mouse-move: any movement reveals the transport and
    // resets the timer. A click on the video toggles visibility (the
    // Netflix tap-to-show pattern); Play.tsx wires that up by calling
    // toggleVisibilityFromTap. We expose it via the ref imperatively
    // through window-level pointer events on the play screen.
    useEffect(() => {
        function onPointerMove() {
            armHideTimer();
        }
        window.addEventListener("pointermove", onPointerMove);
        return () => window.removeEventListener("pointermove", onPointerMove);
    }, [armHideTimer]);

    // Tap on the video toggles transport visibility. Listening on the
    // play-screen container catches taps that fall through the video
    // element. We use bubble-phase pointerup on document.body and
    // filter to events whose target is the video (or the play screen
    // background).
    useEffect(() => {
        function onPointerUp(e: PointerEvent) {
            const t = e.target as HTMLElement | null;
            if (!t) return;
            // Only toggle when the tap landed on the video itself or
            // the play screen background, not on the transport or its
            // controls.
            const isOnVideo = t.tagName === "VIDEO";
            const isOnBackground = t.classList?.contains("play-screen") ?? false;
            if (!isOnVideo && !isOnBackground) return;
            if (visible) {
                setVisible(false);
                if (hideTimerRef.current !== null) {
                    window.clearTimeout(hideTimerRef.current);
                    hideTimerRef.current = null;
                }
            } else {
                setVisible(true);
                armHideTimer();
            }
        }
        document.addEventListener("pointerup", onPointerUp);
        return () => document.removeEventListener("pointerup", onPointerUp);
    }, [visible, armHideTimer]);

    // Pointer events on the rail: click-to-seek and drag-to-seek.
    // Pointer events cover both touch and mouse uniformly.
    const onRailPointerDown = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            const v = videoRef.current;
            const rail = railRef.current;
            if (!v || !rail || !isFinite(v.duration) || v.duration <= 0) return;
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            draggingRef.current = true;
            const apply = (clientX: number) => {
                const rect = rail.getBoundingClientRect();
                const ratio = Math.max(
                    0,
                    Math.min(1, (clientX - rect.left) / rect.width),
                );
                const t = ratio * v.duration;
                v.currentTime = t;
                lastSeekTargetRef.current = t;
                applyScrubberPosition(t, v.duration, fillRef, thumbRef);
                applyTimeLabel(t, v.duration, timeLabelRef);
            };
            apply(e.clientX);
            const move = (ev: PointerEvent) => apply(ev.clientX);
            const up = () => {
                draggingRef.current = false;
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", up);
                window.removeEventListener("pointercancel", up);
                armHideTimer();
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
            window.addEventListener("pointercancel", up);
            armHideTimer();
            setFocus({ kind: "scrubber" });
        },
        [videoRef, armHideTimer],
    );

    // Reset the seek base whenever the video position settles back to
    // the actual currentTime (i.e. between input bursts).
    useEffect(() => {
        const v = videoRef.current;
        if (!v) return;
        const onSeeked = () => {
            lastSeekTargetRef.current = null;
        };
        v.addEventListener("seeked", onSeeked);
        return () => v.removeEventListener("seeked", onSeeked);
    }, [videoRef]);

    // After each render, push the focused button into the DOM focus so
    // assistive tech / TV browsers move the focus ring with the state.
    const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const scrubberRef = useRef<HTMLDivElement | null>(null);
    useLayoutEffect(() => {
        if (!visible) return;
        if (focus.kind === "scrubber") {
            scrubberRef.current?.focus({ preventScroll: true });
        } else {
            buttonRefs.current[focus.index]?.focus({ preventScroll: true });
        }
    }, [focus, visible]);

    return (
        <div
            className={`player-transport ${visible ? "visible" : "hidden"} ${
                paused ? "is-paused" : ""
            }`}
            role="toolbar"
            aria-label="Video controls"
            aria-hidden={!visible}
        >
            <div
                className={`pt-scrubber ${
                    focus.kind === "scrubber" ? "focused" : ""
                }`}
            >
                <div
                    ref={(el) => {
                        railRef.current = el;
                        scrubberRef.current = el;
                    }}
                    className="pt-rail"
                    role="slider"
                    aria-label="Seek"
                    aria-valuemin={0}
                    aria-valuemax={Math.round(duration)}
                    tabIndex={focus.kind === "scrubber" ? 0 : -1}
                    onPointerDown={onRailPointerDown}
                    onFocus={() => setFocus({ kind: "scrubber" })}
                >
                    <div ref={fillRef} className="pt-fill" />
                    <div ref={thumbRef} className="pt-thumb" />
                </div>
                <span ref={timeLabelRef} className="pt-time">
                    0:00 / 0:00
                </span>
            </div>
            <div className="pt-buttons">
                {buttons.map((b, i) => (
                    <button
                        key={b.id}
                        ref={(el) => {
                            buttonRefs.current[i] = el;
                        }}
                        type="button"
                        className={`pt-button ${
                            focus.kind === "button" && focus.index === i
                                ? "focused"
                                : ""
                        }`}
                        tabIndex={
                            focus.kind === "button" && focus.index === i ? 0 : -1
                        }
                        onClick={() => {
                            setFocus({ kind: "button", index: i });
                            b.onActivate();
                        }}
                        onFocus={() => setFocus({ kind: "button", index: i })}
                        aria-label={b.label}
                    >
                        <span className="pt-button-icon" aria-hidden>
                            {b.icon}
                        </span>
                        <span className="pt-button-label">{b.label}</span>
                    </button>
                ))}
            </div>
        </div>
    );
}

// attemptPlay calls video.play() and surfaces failure modes to the
// console so we can diagnose the "stuck on pause / can't resume" bug
// from chrome://inspect on the actual TV. Three things can happen:
//   1. play() resolves and the video starts (the happy path).
//   2. play() rejects with a DOMException - autoplay policy, audio
//      focus loss, MediaSession state machine confused.
//   3. play() resolves but video.paused stays true (the unhappy
//      Android path - audio focus held by another app, decoder pool
//      stuck).
// We log all three so future bug reports include actionable signal.
function attemptPlay(v: HTMLVideoElement): void {
    const p = v.play();
    if (!p || typeof p.then !== "function") return;
    p.then(
        () => {
            // Verify the video actually started (case 3 above). If it
            // didn't, surface it. The 250ms timeout matches our scrub
            // tick, well past the moment any honest play() would have
            // resumed playback.
            window.setTimeout(() => {
                if (v.paused) {
                    console.warn(
                        "[player] play() resolved but video is still paused " +
                        "(audio focus / decoder issue?). currentTime=" +
                        v.currentTime + " readyState=" + v.readyState +
                        " networkState=" + v.networkState,
                    );
                }
            }, 250);
        },
        (err) => {
            console.warn("[player] play() rejected:", err);
        },
    );
}

// applyScrubberPosition writes the thumb / fill DOM directly. Avoids
// React reconciliation on every timeupdate.
function applyScrubberPosition(
    currentTime: number,
    duration: number,
    fillRef: React.RefObject<HTMLDivElement | null>,
    thumbRef: React.RefObject<HTMLDivElement | null>,
) {
    if (!isFinite(duration) || duration <= 0) {
        if (fillRef.current) fillRef.current.style.width = "0%";
        if (thumbRef.current) thumbRef.current.style.left = "0%";
        return;
    }
    const ratio = Math.max(0, Math.min(1, currentTime / duration));
    const pct = (ratio * 100).toFixed(2) + "%";
    if (fillRef.current) fillRef.current.style.width = pct;
    if (thumbRef.current) thumbRef.current.style.left = pct;
}

function applyTimeLabel(
    currentTime: number,
    duration: number,
    labelRef: React.RefObject<HTMLSpanElement | null>,
) {
    if (!labelRef.current) return;
    const totalIsLong = isFinite(duration) && duration >= 3600;
    const cur = formatTime(currentTime, totalIsLong);
    const tot = isFinite(duration) ? formatTime(duration, totalIsLong) : "0:00";
    labelRef.current.textContent = `${cur} / ${tot}`;
}

function formatTime(seconds: number, longForm: boolean): string {
    if (!isFinite(seconds) || seconds < 0) seconds = 0;
    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const ss = String(s).padStart(2, "0");
    if (longForm || h > 0) {
        const mm = String(m).padStart(2, "0");
        return `${h}:${mm}:${ss}`;
    }
    return `${m}:${ss}`;
}
