import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import {
    useEffectiveActiveMode,
    useEffectiveBodyBreakStatus,
    useEffectiveTimeStatus,
    useEffectiveViewingState,
    // Bare hooks kept as TYPES only (ReturnType<...> references
    // below). Eslint flags the names as unused otherwise.
    useBodyBreakStatus,
    useTimeStatus,
    useViewingState,
} from "./kidStatus";

// KidOverlays mounts at the root of the authenticated kid SPA tree.
// Three responsibilities:
//
//   1. Apply the active mode's dim + warm tint as a CSS filter on
//      <html>. Same expression we ship in the admin preview, just
//      driven by /api/kids/viewing-state.
//   2. Render the lockout overlay (M10 daily budget zero, M12
//      bedtime auto-off, M12 sleep timer fire). Three sources, one
//      visual.
//   3. Render the body-break overlay (M11) when the engine fires a
//      break.
//   4. Cross-fade the body theme + speak voice messages on mode
//      transitions (M13). One TTS utterance per transition.
//
// Each overlay is opt-in: if the server says nothing's happening
// the component renders null and adds no DOM.

type Props = {
    /** The kid SPA passes `true` while a video is actively playing
     *  so the body-break poll runs at a faster cadence. */
    activelyPlaying?: boolean;
};

export default function KidOverlays({ activelyPlaying = false }: Props) {
    // Effective hooks merge the server status with the per-device
    // parent-override layer (web/kids/src/parentOverrides.ts) so
    // overlays reflect what the parent's last override request
    // chose. The bare hooks remain exported for the override
    // modal's "what does the server think" diagnostic surfaces.
    const viewing = useEffectiveViewingState();
    const time = useEffectiveTimeStatus();
    const bodyBreak = useEffectiveBodyBreakStatus(activelyPlaying);
    const activeMode = useEffectiveActiveMode();
    const location = useLocation();

    // Apply dim/warm filter on <html>. Use the same expression the
    // admin preview uses (see web/admin/src/ViewingPreview.tsx
    // buildWarmFilter). Multiply overlay isn't ergonomic to mount on
    // <html>, so we use the single-string variant for now -
    // visually less faithful but no extra DOM.
    useEffect(() => {
        const html = document.documentElement;
        if (!viewing) {
            html.style.removeProperty("filter");
            return;
        }
        const r = clamp01((viewing.warmTintPercent ?? 0) / 100);
        const dim = clamp01((viewing.dimPercent ?? 0) / 100);
        const brightness = 1 - dim * 0.8; // cap dim at 80%
        const sepia = 0.7 * r;
        const saturate = 1 + 1.3 * r;
        const hueRotate = -20 * r;
        const contrast = 1 + 0.05 * r;
        if (r === 0 && dim === 0) {
            html.style.removeProperty("filter");
            return;
        }
        html.style.filter = `brightness(${brightness}) sepia(${sepia}) saturate(${saturate}) hue-rotate(${hueRotate}deg) contrast(${contrast})`;
        html.style.transition = "filter 0.4s ease";
    }, [viewing]);

    // Cross-fade body class when the active mode changes. Theme
    // tokens are simple data attributes consumed by styles.css.
    const themeKey = activeMode?.mode?.themeKey ?? "default";
    useEffect(() => {
        document.body.dataset.theme = themeKey;
    }, [themeKey]);

    // Speak the enter / exit voice message once per mode transition.
    // Skip on the very first read - we don't want a "Welcome to
    // bedtime mode" the moment a kid signs in.
    const [lastModeId, setLastModeId] = useState<number | null>(null);
    useEffect(() => {
        const nextId = activeMode?.mode?.id ?? null;
        if (lastModeId === null) {
            setLastModeId(nextId);
            return;
        }
        if (nextId === lastModeId) return;
        const enter = activeMode?.mode?.enterVoiceMessage;
        if (enter) speak(enter);
        setLastModeId(nextId);
    }, [activeMode, lastModeId]);

    // Lockout overlay. Three triggers, identical visual:
    //   - clock-time auto-off (bedtime cutoff)
    //   - sleep timer fired
    //   - daily budget hit zero
    // The copy differs per trigger to give the kid a clear reason.
    const lockout = pickLockout(viewing, time);

    // The body-break overlay only fires while we're actively
    // playing (covered by the activelyPlaying poll cadence). The
    // server flips `onBreak` true; the overlay shows the reason +
    // countdown.
    const onBreak = !!bodyBreak?.onBreak && activelyPlaying;

    // Don't render any overlay on /login - the kid hasn't signed in
    // yet so polling is disabled anyway, but defense in depth.
    if (location.pathname === "/login") return null;

    return (
        <>
            {lockout && <LockoutOverlay reason={lockout.reason} until={lockout.until} />}
            {onBreak && bodyBreak && <BodyBreakOverlay status={bodyBreak} />}
        </>
    );
}

function clamp01(x: number): number {
    if (x < 0) return 0;
    if (x > 1) return 1;
    return x;
}

// pickLockout returns the rendered lockout state, picking the
// highest-priority trigger when several fire at once. Order:
//   bedtime (clock) > sleep timer > daily-budget zero
// Bedtime supersedes per the design doc.
function pickLockout(
    viewing: ReturnType<typeof useViewingState>,
    time: ReturnType<typeof useTimeStatus>,
): { reason: LockoutReason; until?: string } | null {
    if (viewing?.autoOffActive) {
        if (viewing.autoOffReason === "sleep_timer") {
            return { reason: "sleep_timer" };
        }
        return { reason: "bedtime" };
    }
    if (time?.locked) {
        return { reason: "time_limit", until: time.nextRefillAt };
    }
    return null;
}

type LockoutReason = "bedtime" | "sleep_timer" | "time_limit";

function LockoutOverlay({
    reason,
    until,
}: {
    reason: LockoutReason;
    until?: string;
}) {
    const copy = lockoutCopy(reason, until);
    return (
        <div className="kid-lockout" role="dialog" aria-modal="true">
            <div className="kid-lockout-icon" aria-hidden>
                {reason === "bedtime" || reason === "sleep_timer" ? "🌙" : "⏰"}
            </div>
            <h1 className="kid-lockout-title">{copy.title}</h1>
            <p className="kid-lockout-body">{copy.body}</p>
            <p className="kid-lockout-hint">{copy.hint}</p>
        </div>
    );
}

function lockoutCopy(reason: LockoutReason, until?: string) {
    switch (reason) {
        case "bedtime":
            return {
                title: "It's bedtime",
                body: "TV is off until tomorrow. Sweet dreams!",
                hint: "Ask a grown-up if you need to keep watching.",
            };
        case "sleep_timer":
            return {
                title: "TV's asleep",
                body: "Your sleep timer is up. Time for a break!",
                hint: "Ask a grown-up if you need to keep watching.",
            };
        case "time_limit": {
            const friendly = until ? formatUntil(until) : "later";
            return {
                title: "Out of TV time",
                body: `You used your TV time for now. Come back ${friendly}!`,
                hint: "Ask a grown-up if you need more time.",
            };
        }
    }
}

function formatUntil(iso: string): string {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return "later";
    const d = new Date(t);
    return `at ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

function BodyBreakOverlay({
    status,
}: {
    status: NonNullable<ReturnType<typeof useBodyBreakStatus>>;
}) {
    const remaining = status.onBreakUntil
        ? Math.max(0, Math.ceil((Date.parse(status.onBreakUntil) - Date.now()) / 1000))
        : null;
    const reason = status.onBreakReason ?? "";
    return (
        <div className="kid-bodybreak" role="dialog" aria-modal="true">
            <div className="kid-bodybreak-icon" aria-hidden>
                ✨
            </div>
            <h1 className="kid-bodybreak-title">Time for a quick break</h1>
            {reason && <p className="kid-bodybreak-reason">{reason}</p>}
            {remaining !== null && (
                <p className="kid-bodybreak-countdown">{remaining}s</p>
            )}
            <p className="kid-bodybreak-hint">
                Stand up, stretch, take a sip of water - the show will
                be back in a moment.
            </p>
        </div>
    );
}

// speak fires a single TTS utterance using the browser's
// SpeechSynthesis API. Best-effort - if speech isn't available the
// app keeps working without it.
function speak(text: string) {
    try {
        const utt = new SpeechSynthesisUtterance(text);
        utt.rate = 1;
        utt.pitch = 1;
        window.speechSynthesis.speak(utt);
    } catch {
        // ignore
    }
}
