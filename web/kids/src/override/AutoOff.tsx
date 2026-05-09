// AutoOffStage + AutoOffShiftStage: clock-based auto-off override.
// Stage 1 picks "disable until tomorrow" vs "shift the time"; stage
// 2 (the shift card) collects a ±15-min delta clamped to
// [now, next-local-midnight].

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
    return (
        <ModalShell title="Override auto-off">
            <ActionList
                items={[
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
                        label: "Shift the time (±15m)",
                        onActivate: () =>
                            ctx.push({ kind: "autoOffShift", token }),
                    },
                ]}
            />
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
                        : "—"}
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
