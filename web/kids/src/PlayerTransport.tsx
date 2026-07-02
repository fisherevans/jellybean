import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
    ArrowCounterClockwise,
    Pause,
    Play,
    SkipForward,
} from "@phosphor-icons/react";
import { type PlaybackBackend } from "./player/backend";

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
    // The playback engine, behind the PlaybackBackend seam (jellybean#107).
    // Its surface mirrors the HTMLMediaElement subset this transport uses,
    // so every call site below (v.currentTime, v.paused, v.play(),
    // v.addEventListener, ...) is unchanged from the raw-<video> era.
    backendRef: React.RefObject<PlaybackBackend | null>;
    onRestart: () => void;
    onNextEpisode?: () => void;
    // Emitted whenever the transport's internal visibility flips. The
    // parent uses this to slide the title header in/out alongside the
    // bottom transport so they share one show/hide motion.
    onVisibleChange?: (visible: boolean) => void;
    // The back arrow lives in the title header (rendered by Play.tsx)
    // but is part of this transport's focus rail: D-pad up from the
    // scrubber lands on it, OK on it triggers onBack. We accept a ref
    // to the rendered DOM element so useLayoutEffect can move focus
    // there, plus the activation callback.
    onBack?: () => void;
    backRef?: React.RefObject<HTMLElement | null>;
    // Favorite heart in the header. Focus reaches it from "back" via
    // ArrowRight or from "scrubber" via ArrowUp (preferring favorite
    // over back when it's available). Activation is owned by the
    // parent via onToggleFavorite; the transport just routes focus
    // and Enter.
    onToggleFavorite?: () => void;
    favoriteRef?: React.RefObject<HTMLElement | null>;
    // Held-Enter (1000ms) gesture, mirrors the long-press the kid
    // uses on a focused tile elsewhere. Parent opens the override
    // modal. Short-press behavior (reveal/pause/button activate)
    // is unchanged - long-press just adds a timer on top of it.
    onLongPress?: () => void;
};

type FocusState =
    | { kind: "scrubber" }
    | { kind: "button"; index: number }
    | { kind: "back" }
    | { kind: "favorite" };

const HIDE_TIMEOUT_MS = 7000;
// Held-arrow seek ramp on the scrubber. Kids hold left/right to
// jump further faster; the step grows the longer the key is held.
// First press always uses the smallest step. Repeats fire at
// SEEK_REPEAT_THROTTLE_MS to keep the seek rate sane (raw OS
// repeats can hit 30 Hz).
const SEEK_STEP_SECONDS = 15; // first press / short hold
const SEEK_REPEAT_THROTTLE_MS = 180;
// Quiet period after the last seek event before we commit the
// debounced v.currentTime write. Long enough to absorb a held-arrow
// gesture; short enough that a single tap feels responsive. With
// SEEK_REPEAT_THROTTLE_MS=180 a hold fires keydowns ~5/sec, so 350ms
// of quiet reliably means the kid has released the key.
const SEEK_COMMIT_DELAY_MS = 350;
const SEEK_RAMP: { afterMs: number; stepSeconds: number }[] = [
    { afterMs: 0, stepSeconds: 15 },
    { afterMs: 1000, stepSeconds: 30 },
    { afterMs: 2500, stepSeconds: 60 },
    { afterMs: 5000, stepSeconds: 120 },
];
const TIME_TICK_MS = 250;

type ButtonDef = {
    id: "restart" | "playpause" | "next";
    label: string;
    icon: React.ReactNode; // dynamic for play/pause
    onActivate: () => void;
};

const ICON_SIZE = 48;

export default function PlayerTransport({
    backendRef,
    onRestart,
    onNextEpisode,
    onVisibleChange,
    onBack,
    backRef,
    onToggleFavorite,
    favoriteRef,
    onLongPress,
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
    // Split time labels: elapsed sits to the left of the rail, remaining
    // to the right. The combined "0:00 / 0:00" label was readable but
    // wasted the natural eye-line on either end of the scrubber.
    const timeIntoRef = useRef<HTMLSpanElement | null>(null);
    const timeRemainingRef = useRef<HTMLSpanElement | null>(null);
    // Wall-clock end time ("Ends at 4:17pm"), bottom-right of screen.
    const endsAtRef = useRef<HTMLSpanElement | null>(null);
    const railRef = useRef<HTMLDivElement | null>(null);

    const hideTimerRef = useRef<number | null>(null);

    // Drag state for pointer-driven scrubbing. While dragging the time
    // tick should not overwrite the user's draft position; the rAF /
    // interval read defers to the dragged position via this ref.
    const draggingRef = useRef(false);

    // Most recent commited currentTime (seconds). Used so left/right
    // hold-to-repeat doesn't accumulate beyond what was just applied.
    const lastSeekTargetRef = useRef<number | null>(null);

    // Debounce for the actual v.currentTime write. Each held-arrow
    // press updates lastSeekTargetRef + the visual scrubber
    // immediately for instant feedback, but the real seek only fires
    // after SEEK_COMMIT_DELAY_MS of quiet. Without this, every
    // keydown during a hold triggers an HLS segment cancel + retarget,
    // and Jellyfin's transcoder has to cold-start at each new offset
    // - that's the 15-30s "bouncing jellybean" the user saw.
    const seekCommitTimerRef = useRef<number | null>(null);

    // While a seek gesture is in flight we pause the video so the
    // 250ms time-tick poll (from applyScrubberPosition's interval)
    // doesn't keep advancing the thumb back to the actual playhead -
    // that's what made the scrubber visibly bounce while seeking
    // mid-playback. wasPlayingBeforeSeekRef remembers whether the
    // video was playing when the gesture started; the commit
    // resumes if so. Cleared on manual pause/play so we don't fight
    // the kid's intent.
    const wasPlayingBeforeSeekRef = useRef(false);

    // Held-arrow seek state. Tracks the active hold so each
    // keydown can compute "how long has the kid been holding" ->
    // step size from SEEK_RAMP. We don't trust e.repeat: Android
    // WebView's behavior varies by version (some emit a stream of
    // e.repeat=false keydowns for held keys instead of toggling
    // e.repeat). Time-since-last-keydown is robust across both
    // patterns - if two arrows arrive within 250ms, we treat it
    // as the same hold and accumulate elapsed time.
    const seekHoldRef = useRef<{
        key: "ArrowLeft" | "ArrowRight";
        startedAt: number;
        lastEventAt: number;
        lastSeekAt: number;
    } | null>(null);

    // Held-Enter state for the long-press override gesture. Same
    // time-since-last-event pattern as seekHoldRef: e.repeat is
    // unreliable on the Skyworth Android TV WebView for the OK
    // button (auto-repeat keydowns arrive with repeat=false), so
    // we identify a continuing hold by "another Enter keydown
    // within 250ms of the last one." Without this, every repeat
    // re-fires the play/pause button activation - which is what
    // the kid sees as "flashing between play and pause" and which
    // also re-arms the long-press timer so it never reaches 1s.
    const enterHoldRef = useRef<{
        startedAt: number;
        lastEventAt: number;
    } | null>(null);
    const enterHoldTimerRef = useRef<number | null>(null);
    // Set when the long-press timer fires so any further repeat
    // keydowns before keyup don't fall through to button
    // activation behind the just-opened override modal. Cleared on
    // keyup.
    const enterLongPressFiredRef = useRef(false);
    // Latest onLongPress without re-binding the keydown effect on
    // every Play.tsx render (parent re-renders for transportVisible /
    // status / etc., but the keydown effect's dep list intentionally
    // excludes those to avoid re-binding mid-gesture).
    const onLongPressRef = useRef(onLongPress);
    onLongPressRef.current = onLongPress;

    // bufferingRef tracks whether the <video> is currently waiting on
    // data (buffering). The auto-hide timer is suppressed while
    // buffering: the kid expects the transport to stay up while the
    // loading bean is on screen, so they can see seek targets land
    // and progress resume without the controls disappearing in the
    // middle of a stall.
    const bufferingRef = useRef(false);

    // Reset the auto-hide timer. The transport stays visible while
    // paused (mirrors Netflix) AND while buffering. While actively
    // playing, schedule a hide after HIDE_TIMEOUT_MS.
    const armHideTimer = useCallback(() => {
        if (hideTimerRef.current !== null) {
            window.clearTimeout(hideTimerRef.current);
            hideTimerRef.current = null;
        }
        const v = backendRef.current;
        if (v && !v.paused && !bufferingRef.current) {
            hideTimerRef.current = window.setTimeout(() => {
                setVisible(false);
            }, HIDE_TIMEOUT_MS);
        }
    }, [backendRef]);

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
        const v = backendRef.current;
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
        // `waiting` fires when playback stalls for buffering (post
        // seek, network hiccup, transcoder cold-start). `playing`
        // fires when data resumes. While buffering we cancel any
        // pending auto-hide so the kid keeps the controls visible
        // for the duration of the stall, then re-arm on resume.
        const onWaiting = () => {
            bufferingRef.current = true;
            if (hideTimerRef.current !== null) {
                window.clearTimeout(hideTimerRef.current);
                hideTimerRef.current = null;
            }
            if (hasStartedRef.current) setVisible(true);
        };
        const onPlaying = () => {
            bufferingRef.current = false;
            armHideTimer();
        };
        v.addEventListener("play", onPlay);
        v.addEventListener("pause", onPause);
        v.addEventListener("waiting", onWaiting);
        v.addEventListener("playing", onPlaying);
        v.addEventListener("durationchange", onDurationChange);
        // Sync once at mount in case the events already fired.
        setPaused(v.paused);
        if (isFinite(v.duration)) setDuration(v.duration);
        return () => {
            v.removeEventListener("play", onPlay);
            v.removeEventListener("pause", onPause);
            v.removeEventListener("waiting", onWaiting);
            v.removeEventListener("playing", onPlaying);
            v.removeEventListener("durationchange", onDurationChange);
        };
    }, [backendRef, armHideTimer]);

    // Tick: read currentTime from the video and update the scrubber
    // thumb / fill / time label imperatively. 250ms is roughly what
    // YouTube's web player uses; it's smooth enough at 1080p and avoids
    // doing per-frame work on a slow TV.
    useEffect(() => {
        const v = backendRef.current;
        if (!v) return;
        let raf = 0;
        const tick = () => {
            // Skip the tick when the kid is actively scrubbing (pointer
            // drag OR a debounced keyboard seek hasn't committed yet).
            // Otherwise the poll reads v.currentTime (the OLD position,
            // since we pause during seeks) and stomps the seek preview
            // we just wrote, making the thumb visibly bounce between
            // the old position and the kid's target.
            if (draggingRef.current) return;
            if (seekCommitTimerRef.current !== null) return;
            applyScrubberPosition(v.currentTime, v.duration, fillRef, thumbRef);
            applyTimeLabel(
                v.currentTime,
                v.duration,
                timeLabelRef,
                timeIntoRef,
                timeRemainingRef,
                endsAtRef,
            );
        };
        tick();
        const id = window.setInterval(tick, TIME_TICK_MS);
        return () => {
            window.clearInterval(id);
            cancelAnimationFrame(raf);
        };
    }, [backendRef, duration]);

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
        icon: <ArrowCounterClockwise weight="fill" size={ICON_SIZE} />,
        onActivate: () => {
            onRestart();
            armHideTimer();
        },
    });
    buttons.push({
        id: "playpause",
        label: paused ? "Play" : "Pause",
        icon: paused ? (
            <Play weight="fill" size={ICON_SIZE} />
        ) : (
            <Pause weight="fill" size={ICON_SIZE} />
        ),
        onActivate: () => {
            const v = backendRef.current;
            if (!v) return;
            console.log(
                `[player] playpause.activate -> v.paused=${v.paused} -> ${
                    v.paused ? "calling play()" : "calling pause()"
                }`,
            );
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
            icon: <SkipForward weight="fill" size={ICON_SIZE} />,
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
            const v = backendRef.current;
            if (!v || !isFinite(v.duration)) return;
            const base = lastSeekTargetRef.current ?? v.currentTime;
            const next = Math.max(0, Math.min(v.duration - 1, base + deltaSeconds));
            // Update the visual scrubber + label immediately so the
            // kid sees feedback per press. The actual seek (v.currentTime)
            // is debounced - one commit per gesture, not per press.
            lastSeekTargetRef.current = next;
            applyScrubberPosition(next, v.duration, fillRef, thumbRef);
            applyTimeLabel(
                next,
                v.duration,
                timeLabelRef,
                timeIntoRef,
                timeRemainingRef,
                endsAtRef,
            );
            // First seek of the gesture: if playing, pause and remember
            // to resume on commit. Subsequent seeks within the same
            // gesture (debounce timer still pending) are no-ops here.
            if (seekCommitTimerRef.current === null && !v.paused) {
                wasPlayingBeforeSeekRef.current = true;
                v.pause();
            }
            if (seekCommitTimerRef.current !== null) {
                clearTimeout(seekCommitTimerRef.current);
            }
            seekCommitTimerRef.current = window.setTimeout(() => {
                seekCommitTimerRef.current = null;
                const vid = backendRef.current;
                if (!vid) return;
                const target = lastSeekTargetRef.current;
                if (target === null) return;
                vid.currentTime = target;
                if (wasPlayingBeforeSeekRef.current) {
                    wasPlayingBeforeSeekRef.current = false;
                    void vid.play().catch(() => {});
                }
            }, SEEK_COMMIT_DELAY_MS);
        }
        // stepForElapsed picks the seek size based on how long the kid
        // has been holding the arrow. Walks SEEK_RAMP backwards so the
        // largest matching tier wins.
        function stepForElapsed(elapsedMs: number): number {
            for (let i = SEEK_RAMP.length - 1; i >= 0; i--) {
                if (elapsedMs >= SEEK_RAMP[i].afterMs) {
                    return SEEK_RAMP[i].stepSeconds;
                }
            }
            return SEEK_STEP_SECONDS;
        }
        function togglePlay() {
            const v = backendRef.current;
            if (!v) return;
            // Kid's manual play/pause overrides any pending seek-
            // resume so we don't fight their intent. If they hit pause
            // mid-seek, the debounced commit will still seek but won't
            // auto-play after.
            wasPlayingBeforeSeekRef.current = false;
            if (v.paused) {
                attemptPlay(v);
            } else {
                v.pause();
            }
        }

        function onKey(e: KeyboardEvent) {
            // Trace every keydown that reaches us so chrome://inspect
            // shows exactly what we saw on each press. Drop these
            // logs once the play/pause regression is closed; they
            // generate one line per keypress.
            const v = backendRef.current;
            const visState = visible ? "visible" : "hidden";
            const focusState =
                focus.kind === "scrubber"
                    ? "scrubber"
                    : focus.kind === "back"
                    ? "back"
                    : focus.kind === "favorite"
                    ? "favorite"
                    : `button:${focus.index}`;
            const vState = v
                ? `paused=${v.paused} ct=${v.currentTime.toFixed(2)} rs=${v.readyState}`
                : "novideo";
            console.log(
                `[player] key="${e.key}" repeat=${e.repeat} ` +
                `visible=${visState} focus=${focusState} ${vState}`,
            );

            // Scrubber + arrow: special-case BEFORE the global
            // e.repeat skip below. Held repeats are deliberate here -
            // the kid is scrubbing - and the step accelerates with
            // hold duration. We detect "held" by time-since-last-
            // event rather than e.repeat (unreliable on Android
            // WebView). SEEK_REPEAT_THROTTLE_MS bounds the seek rate
            // when the OS feeds keydowns faster than that.
            if (
                focus.kind === "scrubber" &&
                (e.key === "ArrowLeft" || e.key === "ArrowRight")
            ) {
                e.preventDefault();
                const wasRevealed = showOnInput();
                if (wasRevealed) {
                    // Transport was hidden - first arrow only reveals,
                    // matches the consumed-press pattern below.
                    return;
                }
                const now = performance.now();
                const direction = e.key === "ArrowRight" ? 1 : -1;
                let hold = seekHoldRef.current;
                const isContinuingHold =
                    hold !== null &&
                    hold.key === e.key &&
                    now - hold.lastEventAt < 250;
                if (!isContinuingHold) {
                    hold = {
                        key: e.key,
                        startedAt: now,
                        lastEventAt: now,
                        lastSeekAt: 0,
                    };
                    seekHoldRef.current = hold;
                } else {
                    hold!.lastEventAt = now;
                }
                if (now - hold!.lastSeekAt < SEEK_REPEAT_THROTTLE_MS) {
                    return;
                }
                hold!.lastSeekAt = now;
                const elapsed = now - hold!.startedAt;
                const step = stepForElapsed(elapsed);
                seek(direction * step);
                console.log(
                    `[player]   seek held=${elapsed.toFixed(0)}ms step=${step}s ` +
                    `continuing=${isContinuingHold}`,
                );
                armHideTimer();
                return;
            }
            // Any other key clears the seek-hold tracker so the next
            // arrow press starts from the smallest step.
            seekHoldRef.current = null;

            // Enter/Space gating + long-press timer. Done before the
            // generic e.repeat skip because that flag is unreliable
            // for OK on this WebView; we use elapsed-time-since-last
            // -event to distinguish a held key from a fresh tap.
            //   - Continuing hold (last event <250ms ago): swallow
            //     entirely. The original press already ran the
            //     short-press path; auto-repeats must NOT re-fire it
            //     (otherwise the kid sees pause/play/pause/play
            //     toggling). Long-press timer is left running.
            //   - Long-press already fired this hold: also swallow.
            //     The override modal opened; further keydowns
            //     before keyup must not fall through to button
            //     activation behind it.
            //   - New press: init hold tracker, arm 1000ms long-
            //     press timer, fall through to existing short-press
            //     logic below.
            if (e.key === "Enter" || e.key === " ") {
                const now = performance.now();
                if (enterLongPressFiredRef.current) {
                    e.preventDefault();
                    return;
                }
                const hold = enterHoldRef.current;
                const isContinuing = hold !== null &&
                    now - hold.lastEventAt < 250;
                if (isContinuing) {
                    hold!.lastEventAt = now;
                    e.preventDefault();
                    return;
                }
                enterHoldRef.current = { startedAt: now, lastEventAt: now };
                if (enterHoldTimerRef.current !== null) {
                    window.clearTimeout(enterHoldTimerRef.current);
                    enterHoldTimerRef.current = null;
                }
                if (onLongPressRef.current) {
                    enterHoldTimerRef.current = window.setTimeout(() => {
                        enterHoldTimerRef.current = null;
                        enterLongPressFiredRef.current = true;
                        // Drop DOM focus so a still-held key's
                        // eventual keyup doesn't synthesize a click
                        // on a button behind the override modal.
                        const active = document.activeElement;
                        if (active instanceof HTMLElement &&
                            active !== document.body) {
                            active.blur();
                        }
                        onLongPressRef.current?.();
                    }, 1000);
                }
            }

            // TV remotes auto-repeat keydown when the OK button is held
            // even briefly - a single user tap can fire keydown
            // (repeat=false), keydown (repeat=true), keyup within
            // ~50ms. Without this filter, OK toggles play -> pause ->
            // play in rapid succession, causing the audio to stutter
            // and leaving the parity unpredictable. We always want to
            // act on the original keydown only.
            if (e.repeat) {
                console.log("[player]   skipped: repeat");
                return;
            }

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
                backendRef.current?.play().catch(() => {});
                showOnInput();
                return;
            }
            if (e.key === "MediaPause") {
                backendRef.current?.pause();
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
                // Enter / Space on the reveal press also pauses the
                // video. Kids expect "OK" to mean "stop, let me see
                // the controls" - the prior behavior (reveal-only)
                // surfaced the transport but kept the show running
                // behind it, which made it feel like Enter didn't
                // do anything since the kid wasn't looking at the
                // newly-visible chrome.
                if (e.key === "Enter" || e.key === " ") {
                    backendRef.current?.pause();
                }
                console.log("[player]   action: reveal-only (consumed)");
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
                    // Scrubber -> back arrow. Favorite is reachable
                    // via ArrowRight from back; landing on back keeps
                    // the up-from-scrubber motion predictable
                    // regardless of whether favorite is wired.
                    if (onBack) setFocus({ kind: "back" });
                    else if (onToggleFavorite) setFocus({ kind: "favorite" });
                    return;
                }
                if (e.key === "Enter" || e.key === " ") {
                    // OK on scrubber: no-op (the issue spec says seeks
                    // commit live, so OK has nothing left to do).
                    return;
                }
                return;
            }
            if (focus.kind === "favorite") {
                if (e.key === "ArrowLeft") {
                    if (onBack) setFocus({ kind: "back" });
                    return;
                }
                if (e.key === "ArrowDown") {
                    setFocus({ kind: "scrubber" });
                    return;
                }
                if (e.key === "Enter" || e.key === " ") {
                    onToggleFavorite?.();
                    return;
                }
                // ArrowRight / ArrowUp: clamp.
                return;
            }
            if (focus.kind === "back") {
                if (e.key === "ArrowRight") {
                    if (onToggleFavorite) setFocus({ kind: "favorite" });
                    return;
                }
                if (e.key === "ArrowDown") {
                    setFocus({ kind: "scrubber" });
                    return;
                }
                if (e.key === "Enter" || e.key === " ") {
                    onBack?.();
                    return;
                }
                // ArrowLeft / ArrowRight / ArrowUp: no neighbors.
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
                console.log(`[player]   action: activate button=${btn?.id ?? "?"}`);
                btn?.onActivate();
                return;
            }
        }

        function onKeyUp(e: KeyboardEvent) {
            // Drop all held-Enter state on release. If the timer
            // hadn't fired yet, this is a short-press release - it
            // already ran on the original keydown so we don't need
            // to re-fire it here. If it had fired, we just clear
            // the long-press-fired latch so the next press starts
            // clean.
            if (e.key !== "Enter" && e.key !== " ") return;
            enterHoldRef.current = null;
            enterLongPressFiredRef.current = false;
            if (enterHoldTimerRef.current !== null) {
                window.clearTimeout(enterHoldTimerRef.current);
                enterHoldTimerRef.current = null;
            }
        }
        window.addEventListener("keydown", onKey);
        window.addEventListener("keyup", onKeyUp);
        return () => {
            window.removeEventListener("keydown", onKey);
            window.removeEventListener("keyup", onKeyUp);
        };
    }, [focus, buttons, showOnInput, backendRef, onBack]);

    // Cancel any pending debounced seek commit on UNMOUNT only. A
    // half-finished hold would otherwise fire v.currentTime on a
    // torn-down video element. Critically NOT bundled with the
    // keydown effect's cleanup above: that cleanup fires on every
    // dep change (e.g. paused-state flips when we pause for a seek,
    // which mutates `buttons`), and clearing the timer there made
    // every first-press reset back to the original position because
    // the tick guard was lifted while the video was still paused.
    useEffect(() => {
        return () => {
            if (seekCommitTimerRef.current !== null) {
                clearTimeout(seekCommitTimerRef.current);
                seekCommitTimerRef.current = null;
            }
            if (enterHoldTimerRef.current !== null) {
                clearTimeout(enterHoldTimerRef.current);
                enterHoldTimerRef.current = null;
            }
        };
    }, []);

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
            const v = backendRef.current;
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
                applyTimeLabel(
                    t,
                    v.duration,
                    timeLabelRef,
                    timeIntoRef,
                    timeRemainingRef,
                    endsAtRef,
                );
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
        [backendRef, armHideTimer],
    );

    // Reset the seek base whenever the video position settles back to
    // the actual currentTime (i.e. between input bursts).
    useEffect(() => {
        const v = backendRef.current;
        if (!v) return;
        const onSeeked = () => {
            lastSeekTargetRef.current = null;
        };
        v.addEventListener("seeked", onSeeked);
        return () => v.removeEventListener("seeked", onSeeked);
    }, [backendRef]);

    // After each render, push the focused button into the DOM focus so
    // assistive tech / TV browsers move the focus ring with the state.
    const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const scrubberRef = useRef<HTMLDivElement | null>(null);
    useLayoutEffect(() => {
        if (!visible) return;
        if (focus.kind === "scrubber") {
            scrubberRef.current?.focus({ preventScroll: true });
        } else if (focus.kind === "back") {
            backRef?.current?.focus({ preventScroll: true });
        } else if (focus.kind === "favorite") {
            favoriteRef?.current?.focus({ preventScroll: true });
        } else {
            buttonRefs.current[focus.index]?.focus({ preventScroll: true });
        }
    }, [focus, visible, backRef, favoriteRef]);

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
                <span
                    ref={timeIntoRef}
                    className="pt-time pt-time-into"
                    aria-label="Time elapsed"
                >
                    0:00
                </span>
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
                <span
                    ref={timeRemainingRef}
                    className="pt-time pt-time-remaining"
                    aria-label="Time remaining"
                >
                    -0:00
                </span>
                {/* Hidden legacy combined label kept so any aria
                    consumers / chrome inspect logs that referenced
                    .pt-time still resolve. The visible labels above
                    are the user-facing surface. */}
                <span
                    ref={timeLabelRef}
                    className="pt-time pt-time-combined"
                    aria-hidden
                />
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
                            console.log(`[player]   onClick button=${b.id}`);
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
            <span
                ref={endsAtRef}
                className="pt-ends-at"
                aria-live="off"
            />
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
function attemptPlay(v: PlaybackBackend): void {
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
    intoRef?: React.RefObject<HTMLSpanElement | null>,
    remainingRef?: React.RefObject<HTMLSpanElement | null>,
    endsAtRef?: React.RefObject<HTMLSpanElement | null>,
) {
    const totalIsLong = isFinite(duration) && duration >= 3600;
    const cur = formatTime(currentTime, totalIsLong);
    const tot = isFinite(duration) ? formatTime(duration, totalIsLong) : "0:00";
    if (labelRef.current) {
        labelRef.current.textContent = `${cur} / ${tot}`;
    }
    if (intoRef?.current) {
        intoRef.current.textContent = cur;
    }
    if (remainingRef?.current) {
        const remainingSec = Math.max(0, (duration || 0) - currentTime);
        remainingRef.current.textContent = `-${formatTime(remainingSec, totalIsLong)}`;
    }
    if (endsAtRef?.current) {
        if (isFinite(duration) && duration > 0) {
            const remainingSec = Math.max(0, duration - currentTime);
            const end = new Date(Date.now() + remainingSec * 1000);
            endsAtRef.current.textContent = `Ends at ${formatClock(end)}`;
        } else {
            endsAtRef.current.textContent = "";
        }
    }
}

// formatClock renders a Date in 12-hour h:mm AM/PM style (e.g.
// "4:17pm"). Lower-case suffix matches the user-facing copy "ends
// at 4:17pm" so it reads conversationally rather than like a system
// clock readout.
function formatClock(d: Date): string {
    let h = d.getHours();
    const m = d.getMinutes();
    const suffix = h >= 12 ? "pm" : "am";
    h = h % 12;
    if (h === 0) h = 12;
    return `${h}:${String(m).padStart(2, "0")}${suffix}`;
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
