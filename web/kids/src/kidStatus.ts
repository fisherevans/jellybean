// Kid-side status polls. Each hook covers one server endpoint and
// resolves into a small typed snapshot used by the overlay
// components in KidOverlays.tsx.
//
// The polls are deliberately single-flight (one in-flight request per
// hook) and tolerant of network blips - we cache the last good
// response so a transient 5xx doesn't flap the overlay state.
//
// Polling cadence is tuned per stream:
//   - viewing-state: 30s (clock auto-off needs minute-ish granularity)
//   - time-status: 30s (refill cadence is in hours)
//   - body-break-status: 10s on /play, 60s elsewhere (covered by the
//     hook accepting an `active` flag)
//   - active-mode: 60s (theme transitions matter once a minute)
//
// All polls also re-fire on visibility change so a TV waking up
// doesn't sit on stale state.

import { useEffect, useRef, useState } from "react";
import { authHeaders, getSession } from "./auth";

// ---- shared fetch helper ----------------------------------------

async function fetchJSON<T>(path: string): Promise<T | null> {
    try {
        const res = await fetch(path, {
            credentials: "same-origin",
            headers: authHeaders(),
        });
        if (!res.ok) return null;
        return (await res.json()) as T;
    } catch {
        return null;
    }
}

// usePolledStatus runs `fetcher` on mount + whenever the document
// becomes visible, and on a fixed interval. Returns the most recent
// non-null response (so the consumer can keep showing the last good
// state across transient network errors).
function usePolledStatus<T>(
    fetcher: () => Promise<T | null>,
    intervalMs: number,
    enabled: boolean = true,
): T | null {
    const [state, setState] = useState<T | null>(null);
    const inFlight = useRef(false);
    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        async function tick() {
            if (inFlight.current) return;
            inFlight.current = true;
            try {
                const next = await fetcher();
                if (!cancelled && next !== null) setState(next);
            } finally {
                inFlight.current = false;
            }
        }
        void tick();
        const id = window.setInterval(tick, intervalMs);
        const onVis = () => {
            if (document.visibilityState === "visible") void tick();
        };
        document.addEventListener("visibilitychange", onVis);
        return () => {
            cancelled = true;
            window.clearInterval(id);
            document.removeEventListener("visibilitychange", onVis);
        };
        // The fetcher itself is captured by closure; consumers should
        // pass a stable callback or the interval will reset every
        // render. Most call sites pass module-level functions.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [intervalMs, enabled]);
    return state;
}

// ---- viewing state (M12) ----------------------------------------

export type ViewingState = {
    dimPercent: number;
    warmTintPercent: number;
    autoOffActive: boolean;
    autoOffReason?: "clock" | "sleep_timer" | string;
    sleepTimerAt?: string;
    nextOverrideExpiresAt?: string;
};

function fetchViewingState(): Promise<ViewingState | null> {
    return fetchJSON<ViewingState>("/api/kids/viewing-state");
}

export function useViewingState(): ViewingState | null {
    const enabled = !!getSession();
    return usePolledStatus(fetchViewingState, 30_000, enabled);
}

// ---- time status (M10) ------------------------------------------

export type TimeStatus = {
    enabled: boolean;
    /** Minutes left in the current daily bucket. */
    minutesRemaining: number;
    /** Wall-clock ISO timestamp when more minutes will be added. */
    nextRefillAt?: string;
    /** When true, the kid's daily budget is exhausted and the lockout
     *  overlay should render. */
    locked: boolean;
};

function fetchTimeStatus(): Promise<TimeStatus | null> {
    return fetchJSON<TimeStatus>("/api/kids/time-status");
}

export function useTimeStatus(): TimeStatus | null {
    const enabled = !!getSession();
    return usePolledStatus(fetchTimeStatus, 30_000, enabled);
}

// ---- body break status (M11) ------------------------------------

export type BodyBreakStatus = {
    enabled: boolean;
    accumulatorMin: number;
    playMinutes: number;
    breakMinutes: number;
    onBreak: boolean;
    onBreakUntil?: string;
    onBreakReason?: string;
    voiceMessage?: string;
};

function fetchBodyBreak(): Promise<BodyBreakStatus | null> {
    return fetchJSON<BodyBreakStatus>("/api/kids/body-break-status");
}

export function useBodyBreakStatus(activelyPlaying: boolean): BodyBreakStatus | null {
    const enabled = !!getSession();
    // Faster cadence while a video is actively playing so the kid
    // sees the break overlay within ~10s of it firing.
    return usePolledStatus(
        fetchBodyBreak,
        activelyPlaying ? 10_000 : 60_000,
        enabled,
    );
}

// ---- active mode (M13) ------------------------------------------

export type ActiveMode = {
    mode?: {
        id: number;
        name: string;
        themeKey: string;
        enterVoiceMessage?: string;
        exitVoiceMessage?: string;
    };
    source: "schedule" | "override" | "none";
    overrideExpiresAt?: string;
};

function fetchActiveMode(): Promise<ActiveMode | null> {
    return fetchJSON<ActiveMode>("/api/kids/active-mode");
}

export function useActiveMode(): ActiveMode | null {
    const enabled = !!getSession();
    return usePolledStatus(fetchActiveMode, 60_000, enabled);
}
