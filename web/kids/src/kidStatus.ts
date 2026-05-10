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
import * as overrides from "./parentOverrides";
import { useParentOverride } from "./parentOverrides";

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
    /** Server-reported list of available modes. Surfaced so the
     *  override modal can render a mode picker without an extra
     *  fetch. Populated only when the server includes it in the
     *  active-mode response. */
    available?: { id: number; name: string; themeKey: string }[];
};

function fetchActiveMode(): Promise<ActiveMode | null> {
    return fetchJSON<ActiveMode>("/api/kids/active-mode");
}

export function useActiveMode(): ActiveMode | null {
    const enabled = !!getSession();
    return usePolledStatus(fetchActiveMode, 60_000, enabled);
}

// ---- merged readers (server + parent override) ------------------
//
// Each `useEffective*` hook subscribes to BOTH the server poll and
// the local parent-override layer, returning a snapshot that
// reflects whichever is "active" right now. Components that need
// the actual displayed value (KidOverlays, the override modal's
// summary lines, the time-limit gate) should call these instead
// of the bare server hooks.
//
// Mode resolution:
//   - local override `action: "set"` -> use override's mode (look
//     up in `available` list).
//   - local override `action: "disable"` -> render as "no mode"
//     even if the server schedule says otherwise.
//   - else: server result unchanged.

export function useEffectiveActiveMode(): ActiveMode | null {
    const server = useActiveMode();
    const override = useParentOverride(() => overrides.getMode());
    if (!server) return null;
    if (!override) return server;
    if (override.action === "disable") {
        return {
            ...server,
            mode: undefined,
            source: "override",
            overrideExpiresAt: override.expiresAt,
        };
    }
    const picked =
        server.available?.find((m) => m.id === override.modeId) ??
        (server.mode && server.mode.id === override.modeId
            ? server.mode
            : undefined);
    if (!picked) return server; // override referenced an unknown mode; fall back
    return {
        ...server,
        mode: {
            id: picked.id,
            name: picked.name,
            themeKey: picked.themeKey,
        },
        source: "override",
        overrideExpiresAt: override.expiresAt,
    };
}

// Time resolution:
//   - local `disabledUntil` in future -> minutesRemaining is
//     effectively unlimited (we report a large sentinel) and
//     `locked` is false.
//   - local `setMinutesRemaining` (when server reports
//     `enabled=false`) -> surface as an enabled budget so the kid
//     gets a one-off daily cap even when no server-side limit
//     exists.
//   - local `addedMinutes` -> add to minutesRemaining; when the
//     server reports no global limit we still surface the bonus
//     as the effective budget so the override-only path produces
//     a visible cap.
//   - else: server unchanged.
export function useEffectiveTimeStatus(): TimeStatus | null {
    const server = useTimeStatus();
    const override = useParentOverride(() => overrides.getGlobalTime());
    if (!server) return null;
    if (!override) return server;
    if (
        override.disabledUntil &&
        Date.parse(override.disabledUntil) > Date.now()
    ) {
        return {
            ...server,
            enabled: server.enabled,
            minutesRemaining: 24 * 60,
            locked: false,
        };
    }
    // Override-only path: server has no daily limit, but the
    // parent set one for today. Treat the override as the
    // authoritative budget.
    if (!server.enabled && override.setMinutesRemaining !== undefined) {
        const total =
            override.setMinutesRemaining +
            (override.addedMinutes && override.addedMinutes > 0
                ? override.addedMinutes
                : 0);
        return {
            ...server,
            enabled: true,
            minutesRemaining: total,
            locked: total <= 0,
        };
    }
    if (override.addedMinutes && override.addedMinutes > 0) {
        // When the server has no limit, surface the bonus as the
        // effective budget so a "+30m" override still produces a
        // visible cap for today.
        const base = server.enabled ? server.minutesRemaining : 0;
        return {
            ...server,
            enabled: server.enabled || override.addedMinutes > 0,
            minutesRemaining: base + override.addedMinutes,
            locked: false,
        };
    }
    return server;
}

// Body breaks resolution:
//   - local `disabledUntil` in future -> render as if breaks are
//     not currently active. Server's "enabled" + accumulator stay
//     visible (so the parent can see what would have happened).
export function useEffectiveBodyBreakStatus(
    activelyPlaying: boolean,
): BodyBreakStatus | null {
    const server = useBodyBreakStatus(activelyPlaying);
    const override = useParentOverride(() => overrides.getBodyBreaks());
    if (!server) return null;
    if (!override || !override.disabledUntil) return server;
    if (Date.parse(override.disabledUntil) > Date.now()) {
        return {
            ...server,
            onBreak: false,
            onBreakUntil: undefined,
            onBreakReason: undefined,
            voiceMessage: undefined,
        };
    }
    return server;
}

// FeatureSummary is the shape every override-menu summarizer
// returns. The MenuSections rows read this to (a) decide between
// "Temporarily turn on …" and the configured-feature verb, and
// (b) render a one-line status sub-text under the action label.
//
//   isOn:       feature is currently producing an effect on the
//               kid (server-configured OR override-driven).
//   isOverride: a local override is currently active. May be true
//               while isOn is false (e.g. body breaks paused via
//               override - the feature exists, but the active
//               effect right now is "no effect").
//   status:     short human string the menu shows under the
//               action label. "Off" when nothing is happening.
export type FeatureSummary = {
    status: string;
    isOn: boolean;
    isOverride: boolean;
};

function formatTimeShort(iso: string): string {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return "soon";
    return d.toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
    });
}

function formatHM(totalMinutes: number): string {
    const m = Math.max(0, Math.round(totalMinutes));
    const h = Math.floor(m / 60);
    const rem = m % 60;
    if (h === 0) return `${rem}m`;
    if (rem === 0) return `${h}h`;
    return `${h}h ${rem}m`;
}

// summarizeAutoOff produces the menu status line for the auto-off
// row. Inputs are the merged viewing state + the local override
// (independent so the caller can subscribe via useParentOverride
// without an extra hook layer). Server-side configuration is
// reflected by `serverSleepTimerAt` - present means a clock-off
// is configured today.
export function summarizeAutoOff(
    viewing: ViewingState | null,
    autoOff: overrides.AutoOffOverride | null,
    serverSleepTimerAt?: string,
): FeatureSummary {
    const isOverride = !!autoOff;
    if (autoOff?.disabledUntilMidnight) {
        return {
            status: "Skipped until tomorrow (override)",
            isOn: false,
            isOverride: true,
        };
    }
    if (autoOff?.oneTimeAt) {
        return {
            status: `${formatTimeShort(autoOff.oneTimeAt)} tonight (override)`,
            isOn: true,
            isOverride: true,
        };
    }
    if (autoOff?.shiftMinutes && viewing?.sleepTimerAt) {
        return {
            status: `${formatTimeShort(viewing.sleepTimerAt)} today (override)`,
            isOn: true,
            isOverride: true,
        };
    }
    if (serverSleepTimerAt) {
        return {
            status: formatTimeShort(serverSleepTimerAt),
            isOn: true,
            isOverride: false,
        };
    }
    return { status: "Off", isOn: false, isOverride };
}

// summarizeGlobalTime: status line for the global daily time
// limit row. Server `enabled=true` => budgeted, with a
// minutesRemaining count. Override-only path => budget comes
// entirely from the local layer.
export function summarizeGlobalTime(
    server: TimeStatus | null,
    effective: TimeStatus | null,
    override: overrides.TimeOverride | null,
): FeatureSummary {
    const isOverride = !!override;
    if (
        override?.disabledUntil &&
        Date.parse(override.disabledUntil) > Date.now()
    ) {
        return {
            status: `No limit until ${formatTimeShort(override.disabledUntil)} (override)`,
            isOn: false,
            isOverride: true,
        };
    }
    if (effective?.enabled) {
        const left = formatHM(effective.minutesRemaining);
        if (isOverride) {
            return {
                status: `${left} left today (override)`,
                isOn: true,
                isOverride: true,
            };
        }
        if (server?.enabled) {
            return {
                status: `${left} left today`,
                isOn: true,
                isOverride: false,
            };
        }
    }
    return { status: "Off", isOn: false, isOverride };
}

// summarizeBodyBreaks: status line for the body-breaks row.
// Override pauses breaks until a fixed time; configured but
// non-paused state surfaces the cadence.
export function summarizeBodyBreaks(
    server: BodyBreakStatus | null,
    override: overrides.BodyBreaksOverride | null,
): FeatureSummary {
    const isOverride = !!(
        override?.disabledUntil &&
        Date.parse(override.disabledUntil) > Date.now()
    );
    if (isOverride && override?.disabledUntil) {
        return {
            status: `Paused until ${formatTimeShort(override.disabledUntil)} (override)`,
            isOn: false,
            isOverride: true,
        };
    }
    if (server?.enabled) {
        const cadence = `${server.breakMinutes}min break every ${server.playMinutes}min`;
        return {
            status: `On - ${cadence}`,
            isOn: true,
            isOverride: false,
        };
    }
    return { status: "Off", isOn: false, isOverride: false };
}

// summarizeViewingPercent handles dim and warm in one shape -
// they're override-only on the server today, so the status
// reduces to "Off" or "<n>% until <time> (override)".
export function summarizeViewingPercent(
    serverPercent: number | undefined,
    override: overrides.ViewingOverride | null,
): FeatureSummary {
    if (override) {
        return {
            status: `${override.percent}% until ${formatTimeShort(override.expiresAt)} (override)`,
            isOn: override.percent > 0,
            isOverride: true,
        };
    }
    if (serverPercent && serverPercent > 0) {
        return {
            status: `${serverPercent}%`,
            isOn: true,
            isOverride: false,
        };
    }
    return { status: "Off", isOn: false, isOverride: false };
}

// summarizeMode: status line for the mode row. Server reports a
// scheduled mode; override can disable or swap.
export function summarizeMode(
    server: ActiveMode | null,
    override: overrides.ModeOverride | null,
): FeatureSummary {
    const serverMode = server?.mode;
    if (override?.action === "disable") {
        const baseName = serverMode?.name ?? "mode";
        return {
            status: `${baseName} disabled until ${formatTimeShort(override.expiresAt)} (override)`,
            isOn: false,
            isOverride: true,
        };
    }
    if (override?.action === "set") {
        const picked =
            server?.available?.find((m) => m.id === override.modeId)?.name ??
            (serverMode?.id === override.modeId ? serverMode.name : undefined);
        const name = picked ?? "Mode";
        return {
            status: `${name} until ${formatTimeShort(override.expiresAt)} (override)`,
            isOn: true,
            isOverride: true,
        };
    }
    if (serverMode) {
        return {
            status: `${serverMode.name} mode`,
            isOn: true,
            isOverride: false,
        };
    }
    return { status: "Off", isOn: false, isOverride: false };
}

// Viewing resolution: dim and warm percent get overridden if a
// per-control local override is active. Auto-off (clock-driven on
// the server) gets shifted / disabled by the local autoOff
// override.
export function useEffectiveViewingState(): ViewingState | null {
    const server = useViewingState();
    const dim = useParentOverride(() => overrides.getDim());
    const warm = useParentOverride(() => overrides.getWarm());
    const autoOff = useParentOverride(() => overrides.getAutoOff());
    if (!server) return null;
    let dimPercent = server.dimPercent;
    let warmPercent = server.warmTintPercent;
    let autoOffActive = server.autoOffActive;
    let sleepTimerAt = server.sleepTimerAt;
    if (dim) dimPercent = dim.percent;
    if (warm) warmPercent = warm.percent;
    if (autoOff?.disabledUntilMidnight) {
        // Skip auto-off entirely until tomorrow.
        autoOffActive = false;
        sleepTimerAt = undefined;
    } else if (autoOff?.oneTimeAt) {
        // Override-only path: server has no auto-off configured,
        // but the parent set a one-time absolute fire time. Use
        // it as the effective sleep-timer.
        sleepTimerAt = autoOff.oneTimeAt;
        autoOffActive = Date.parse(autoOff.oneTimeAt) <= Date.now();
    } else if (autoOff?.shiftMinutes && sleepTimerAt) {
        // Shift the sleep-timer fire time. Negative = earlier.
        const shifted = new Date(
            Date.parse(sleepTimerAt) + autoOff.shiftMinutes * 60_000,
        ).toISOString();
        sleepTimerAt = shifted;
        // Recompute autoOffActive against the shifted time.
        autoOffActive = Date.parse(shifted) <= Date.now();
    }
    return {
        ...server,
        dimPercent,
        warmTintPercent: warmPercent,
        autoOffActive,
        sleepTimerAt,
    };
}
