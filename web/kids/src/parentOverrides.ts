// parentOverrides is the device-local layer the parent override
// modal writes to. The kid client merges these on top of
// server-reported status (kidStatus.ts) before applying.
//
// Why local-only: the parent is sitting at THIS TV with the kid;
// the override should affect this device's experience for the
// next 30m / hour / rest of day, not propagate to the kid's other
// devices. Cross-device sync would also race with the
// schedule-driven server side and be hard to reason about.
//
// Storage: localStorage keys under `jellybean.kids.overrides.*`.
// Wiped by clearSession() (auth.ts iterates the
// `jellybean.kids.` prefix). Each read prunes its own key when
// expired so we don't need a background timer.
//
// Subscribe model: writes dispatch a CustomEvent on window so
// React components in the same tab can re-render. The native
// `storage` event only fires across tabs/frames, not within the
// same one - the CustomEvent fills that gap.

const PREFIX = "jellybean.kids.overrides.";
const CONTENT_TIME_PREFIX = `${PREFIX}contentTime.`;
const KEY_GLOBAL_TIME = `${PREFIX}globalTime`;
const KEY_MODE = `${PREFIX}mode`;
const KEY_DIM = `${PREFIX}dim`;
const KEY_WARM = `${PREFIX}warm`;
const KEY_BODY_BREAKS = `${PREFIX}bodyBreaks`;
const KEY_AUTO_OFF = `${PREFIX}autoOff`;

const CHANGE_EVENT = "jellybean:parent-overrides-change";

export type TimeOverride = {
    /** Bonus minutes to add on top of the kid's bucket today. */
    addedMinutes?: number;
    /** ISO timestamp; if in the future, the limit is suspended
     *  ("no limit until..."). */
    disabledUntil?: string;
    /** When this override stops applying (defaults to next midnight
     *  if absent). */
    expiresAt?: string;
};

export type ModeOverride =
    | { action: "disable"; expiresAt: string }
    | { action: "set"; modeId: number; expiresAt: string };

export type ViewingOverride = {
    /** 0..100 */
    percent: number;
    expiresAt: string;
};

export type BodyBreaksOverride = {
    /** Body breaks suppressed until this ISO timestamp. */
    disabledUntil: string;
};

export type AutoOffOverride = {
    /** When true, skip auto-off entirely until next local midnight. */
    disabledUntilMidnight?: boolean;
    /** Signed minutes to shift the configured auto-off time today.
     *  Negative = earlier; positive = later. */
    shiftMinutes?: number;
    /** When this override stops applying (next local midnight). */
    expiresAt: string;
};

// ---- shared helpers ---------------------------------------------

function readJSON<T>(key: string): T | null {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

function writeJSON(key: string, value: unknown): void {
    try {
        localStorage.setItem(key, JSON.stringify(value));
        emitChange();
    } catch {
        /* quota etc. - silently drop */
    }
}

function removeKey(key: string): void {
    try {
        localStorage.removeItem(key);
        emitChange();
    } catch {
        /* ignore */
    }
}

function isExpired(iso: string | undefined): boolean {
    if (!iso) return false;
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return true;
    return t <= Date.now();
}

function emitChange(): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

// nextLocalMidnight returns the ISO timestamp for tomorrow's
// midnight in the device's local timezone. Used by "rest of day"
// / "...until tomorrow" duration choices.
export function nextLocalMidnight(now: Date = new Date()): string {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 1);
    return d.toISOString();
}

// expiresFromMinutes returns ISO timestamp `minutes` from now.
export function expiresFromMinutes(minutes: number, now: Date = new Date()): string {
    return new Date(now.getTime() + minutes * 60_000).toISOString();
}

// ---- per-content time -------------------------------------------

function contentTimeKey(itemId: string): string {
    return CONTENT_TIME_PREFIX + itemId;
}

export function getContentTime(itemId: string): TimeOverride | null {
    const v = readJSON<TimeOverride>(contentTimeKey(itemId));
    if (!v) return null;
    if (isExpired(v.expiresAt) && isExpired(v.disabledUntil)) {
        removeKey(contentTimeKey(itemId));
        return null;
    }
    return v;
}

export function setContentTime(itemId: string, v: TimeOverride): void {
    writeJSON(contentTimeKey(itemId), v);
}

export function clearContentTime(itemId: string): void {
    removeKey(contentTimeKey(itemId));
}

// ---- global time ------------------------------------------------

export function getGlobalTime(): TimeOverride | null {
    const v = readJSON<TimeOverride>(KEY_GLOBAL_TIME);
    if (!v) return null;
    if (isExpired(v.expiresAt) && isExpired(v.disabledUntil)) {
        removeKey(KEY_GLOBAL_TIME);
        return null;
    }
    return v;
}

export function setGlobalTime(v: TimeOverride): void {
    writeJSON(KEY_GLOBAL_TIME, v);
}

export function clearGlobalTime(): void {
    removeKey(KEY_GLOBAL_TIME);
}

// ---- mode -------------------------------------------------------

export function getMode(): ModeOverride | null {
    const v = readJSON<ModeOverride>(KEY_MODE);
    if (!v) return null;
    if (isExpired(v.expiresAt)) {
        removeKey(KEY_MODE);
        return null;
    }
    return v;
}

export function setMode(v: ModeOverride): void {
    writeJSON(KEY_MODE, v);
}

export function clearMode(): void {
    removeKey(KEY_MODE);
}

// ---- dim / warm -------------------------------------------------

export function getDim(): ViewingOverride | null {
    const v = readJSON<ViewingOverride>(KEY_DIM);
    if (!v || isExpired(v.expiresAt)) {
        if (v) removeKey(KEY_DIM);
        return null;
    }
    return v;
}
export function setDim(v: ViewingOverride): void {
    writeJSON(KEY_DIM, v);
}
export function clearDim(): void {
    removeKey(KEY_DIM);
}

export function getWarm(): ViewingOverride | null {
    const v = readJSON<ViewingOverride>(KEY_WARM);
    if (!v || isExpired(v.expiresAt)) {
        if (v) removeKey(KEY_WARM);
        return null;
    }
    return v;
}
export function setWarm(v: ViewingOverride): void {
    writeJSON(KEY_WARM, v);
}
export function clearWarm(): void {
    removeKey(KEY_WARM);
}

// ---- body breaks ------------------------------------------------

export function getBodyBreaks(): BodyBreaksOverride | null {
    const v = readJSON<BodyBreaksOverride>(KEY_BODY_BREAKS);
    if (!v) return null;
    if (isExpired(v.disabledUntil)) {
        removeKey(KEY_BODY_BREAKS);
        return null;
    }
    return v;
}
export function setBodyBreaks(v: BodyBreaksOverride): void {
    writeJSON(KEY_BODY_BREAKS, v);
}
export function clearBodyBreaks(): void {
    removeKey(KEY_BODY_BREAKS);
}

// ---- auto-off ---------------------------------------------------

export function getAutoOff(): AutoOffOverride | null {
    const v = readJSON<AutoOffOverride>(KEY_AUTO_OFF);
    if (!v) return null;
    if (isExpired(v.expiresAt)) {
        removeKey(KEY_AUTO_OFF);
        return null;
    }
    return v;
}
export function setAutoOff(v: AutoOffOverride): void {
    writeJSON(KEY_AUTO_OFF, v);
}
export function clearAutoOff(): void {
    removeKey(KEY_AUTO_OFF);
}

// ---- React subscribe helper -------------------------------------

import { useEffect, useState } from "react";

// useParentOverride re-runs `read` on every parent-override write
// (same tab) and on cross-tab `storage` events. Read is also
// re-run on mount, so the initial value is fresh.
export function useParentOverride<T>(read: () => T): T {
    const [value, setValue] = useState<T>(read);
    useEffect(() => {
        const handler = () => setValue(read());
        window.addEventListener(CHANGE_EVENT, handler);
        window.addEventListener("storage", handler);
        return () => {
            window.removeEventListener(CHANGE_EVENT, handler);
            window.removeEventListener("storage", handler);
        };
        // The read closure is captured per-mount; consumers should
        // pass a stable function (most readers below are exported
        // module functions).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return value;
}
