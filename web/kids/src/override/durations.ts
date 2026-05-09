// Shared duration / adjust option sets used by DurationPicker
// stages (mode duration, content time, global time, body breaks,
// auto-off shift). Keeping them in one place so the friendly
// labels and minute math stay aligned across stages.

import { expiresFromMinutes, nextLocalMidnight } from "../parentOverrides";

export type DurationOpt = {
    id: string;
    label: string;
    /** Returns ISO timestamp the override should expire at. Some
     *  options ("rest of day", "until tomorrow") need the current
     *  date to compute, so the resolver runs on click. */
    resolve: () => string;
};

export const DUR_LONG: DurationOpt[] = [
    { id: "30m", label: "30 minutes", resolve: () => expiresFromMinutes(30) },
    { id: "1h", label: "1 hour", resolve: () => expiresFromMinutes(60) },
    { id: "2h", label: "2 hours", resolve: () => expiresFromMinutes(120) },
    { id: "4h", label: "4 hours", resolve: () => expiresFromMinutes(240) },
    { id: "rod", label: "Rest of day", resolve: () => nextLocalMidnight() },
];

// AdjustOpt pairs minutes-to-add OR a "disable until midnight"
// flag with each row. The picker uses minutes when set, else falls
// back to the disabledUntilMidnight branch.
export type AdjustOpt = {
    id: string;
    label: string;
    addedMinutes?: number;
    /** Reset = clear any active override so the kid sees server-
     *  reported state. */
    clear?: true;
    untilMidnight?: true;
};

function makeAdjustOpts(noLimitLabel: string): AdjustOpt[] {
    return [
        { id: "+5m", label: "+5 minutes", addedMinutes: 5 },
        { id: "+15m", label: "+15 minutes", addedMinutes: 15 },
        { id: "+30m", label: "+30 minutes", addedMinutes: 30 },
        { id: "+1h", label: "+1 hour", addedMinutes: 60 },
        { id: "+2h", label: "+2 hours", addedMinutes: 120 },
        { id: "reset", label: "Reset (clear override)", clear: true },
        { id: "until-tomorrow", label: noLimitLabel, untilMidnight: true },
    ];
}

export const ADJUST_TIME = makeAdjustOpts("No limit until tomorrow");
export const ADJUST_BREAKS = makeAdjustOpts("No body breaks until tomorrow");

export const SHIFT_STEP_MIN = 15;

// formatExpiresShort renders a friendly "until 8:30 PM" string for
// the done view.
export function formatExpiresShort(iso: string): string {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return "soon";
    return d.toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
    });
}
