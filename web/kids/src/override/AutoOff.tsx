// AutoOffStage + sub-stages: clock-based auto-off override.
//
// AutoOffStage is the "configured" entrypoint - the menu only
// pushes it when the server reports a sleepTimerAt for today. It
// offers the two adjustments that need a baseline time:
//   - "Disable until tomorrow"
//   - "Shift the time (+/-15m)" -> AutoOffShiftStage
//
// The unconfigured case skips this menu entirely: the parent menu
// pushes AutoOffOneTimeStage directly so the parent picks an
// absolute fire time (e.g. 8pm tonight). Stored as `oneTimeAt` so
// the kidStatus merge surfaces it as the effective sleepTimerAt
// for today.
//
// Both shift / one-time stages clamp to (now, next-local-midnight].

import { useEffect, useRef, useState } from "react";
import * as overrides from "../parentOverrides";
import { nextLocalMidnight } from "../parentOverrides";
import { useViewingState } from "../kidStatus";
import { ActionList, BackLink, ModalShell } from "./shell";
import { SHIFT_STEP_MIN } from "./durations";
import type { StageCtx } from "./types";

type Props = {
    ctx: StageCtx;
    token: string;
};

export function AutoOffStage({ ctx, token }: Props) {
    const items = [
        {
            key: "tomorrow",
            label: "Disable until tomorrow",
            onActivate: () => {
                overrides.setAutoOff({
                    disabledUntilMidnight: true,
                    expiresAt: nextLocalMidnight(),
                });
                ctx.replaceTop({
                    kind: "done",
                    message: "Auto-off skipped until tomorrow.",
                });
            },
        },
        {
            key: "shift",
            label: "Shift the time (+/-15m)",
            onActivate: () => ctx.push({ kind: "autoOffShift", token }),
        },
    ];
    return (
        <ModalShell title="Adjust auto-off">
            <ActionList items={items} />
            <BackLink onActivate={ctx.pop} />
        </ModalShell>
    );
}

type ShiftProps = {
    ctx: StageCtx;
};

export function AutoOffShiftStage({ ctx }: ShiftProps) {
    const viewing = useViewingState();
    const [delta, setDelta] = useState(0);
    const baseTime = viewing?.sleepTimerAt
        ? new Date(viewing.sleepTimerAt)
        : null;
    const shiftedTime = baseTime
        ? new Date(baseTime.getTime() + delta * 60_000)
        : null;
    // Bounds: shifted time must be in [now, next local midnight].
    // Earliest delta = now - baseTime; latest delta = midnight -
    // baseTime. Computed per-render so the bounds advance as the
    // clock ticks.
    const minDelta = baseTime
        ? Math.ceil((Date.now() - baseTime.getTime()) / 60_000)
        : 0;
    const maxDelta = baseTime
        ? Math.floor(
              (Date.parse(nextLocalMidnight()) - baseTime.getTime()) / 60_000,
          )
        : 0;
    const ref = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        ref.current?.focus();
    }, []);
    function onKey(e: React.KeyboardEvent) {
        if (e.key === "ArrowUp") {
            e.preventDefault();
            setDelta((d) => Math.min(maxDelta, d + SHIFT_STEP_MIN));
            return;
        }
        if (e.key === "ArrowDown") {
            e.preventDefault();
            setDelta((d) => Math.max(minDelta, d - SHIFT_STEP_MIN));
            return;
        }
    }
    function save() {
        overrides.setAutoOff({
            shiftMinutes: delta,
            expiresAt: nextLocalMidnight(),
        });
        const sign = delta >= 0 ? "+" : "";
        ctx.replaceTop({
            kind: "done",
            message: `Auto-off shifted ${sign}${delta} min for today.`,
        });
    }
    return (
        <ModalShell title="Shift auto-off time">
            <div className="muted">
                Configured:{" "}
                {baseTime
                    ? baseTime.toLocaleTimeString([], {
                          hour: "numeric",
                          minute: "2-digit",
                      })
                    : "(no clock-off set)"}
            </div>
            <div
                ref={ref}
                tabIndex={0}
                role="spinbutton"
                aria-label="Auto-off shift"
                className="override-shift"
                onKeyDown={onKey}
            >
                <div className="override-shift-delta">
                    {delta >= 0 ? "+" : ""}
                    {delta} min
                </div>
                <div className="override-shift-target">
                    Today:{" "}
                    {shiftedTime
                        ? shiftedTime.toLocaleTimeString([], {
                              hour: "numeric",
                              minute: "2-digit",
                          })
                        : "-"}
                </div>
                <div className="muted">
                    Up = later · Down = earlier · clamps to now / midnight
                </div>
            </div>
            <ActionList
                items={[
                    {
                        key: "save",
                        label: "Save",
                        onActivate: save,
                        disabled: delta === 0,
                    },
                ]}
            />
            <BackLink onActivate={ctx.pop} />
        </ModalShell>
    );
}

// AutoOffOneTimeStage: pick an absolute auto-off time for today.
// Used when no server-side auto-off is configured. Default lands
// 2h from now rounded down to the prior 15min slot, clamped
// under midnight. Up/Down step +/-15min between (now, midnight).
type OneTimeProps = {
    ctx: StageCtx;
};

function roundedDownTo15(d: Date): Date {
    const out = new Date(d);
    const m = out.getMinutes();
    out.setMinutes(m - (m % 15), 0, 0);
    return out;
}

export function AutoOffOneTimeStage({ ctx }: OneTimeProps) {
    const midnight = Date.parse(nextLocalMidnight());
    const initialDefault = roundedDownTo15(
        new Date(Date.now() + 2 * 60 * 60_000),
    );
    // Clamp into the [now+15m, midnight-15m] window.
    const minMs = Date.now() + SHIFT_STEP_MIN * 60_000;
    const maxMs = midnight - SHIFT_STEP_MIN * 60_000;
    const startMs = Math.min(
        Math.max(initialDefault.getTime(), minMs),
        Math.max(maxMs, minMs),
    );
    const [pickedMs, setPickedMs] = useState(startMs);
    const ref = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        ref.current?.focus();
    }, []);
    function step(dir: 1 | -1) {
        setPickedMs((cur) => {
            const next = cur + dir * SHIFT_STEP_MIN * 60_000;
            if (next < minMs) return minMs;
            if (next > maxMs) return maxMs;
            return next;
        });
    }
    function onKey(e: React.KeyboardEvent) {
        if (e.key === "ArrowUp") {
            e.preventDefault();
            step(1);
            return;
        }
        if (e.key === "ArrowDown") {
            e.preventDefault();
            step(-1);
            return;
        }
    }
    function save() {
        const iso = new Date(pickedMs).toISOString();
        overrides.setAutoOff({
            oneTimeAt: iso,
            expiresAt: nextLocalMidnight(),
        });
        ctx.replaceTop({
            kind: "done",
            message: `Auto-off set for ${new Date(pickedMs).toLocaleTimeString(
                [],
                { hour: "numeric", minute: "2-digit" },
            )} today.`,
        });
    }
    const formatted = new Date(pickedMs).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
    });
    return (
        <ModalShell
            title="One-time auto-off"
            subtitle="Pick a time today (15-minute steps)."
        >
            <div
                ref={ref}
                tabIndex={0}
                role="spinbutton"
                aria-label="One-time auto-off time"
                className="override-shift"
                onKeyDown={onKey}
            >
                <div className="override-shift-delta">{formatted}</div>
                <div className="muted">
                    Up = later · Down = earlier · clamps to now / midnight
                </div>
            </div>
            <ActionList
                items={[
                    {
                        key: "save",
                        label: "Save",
                        onActivate: save,
                    },
                ]}
            />
            <BackLink onActivate={ctx.pop} />
        </ModalShell>
    );
}
