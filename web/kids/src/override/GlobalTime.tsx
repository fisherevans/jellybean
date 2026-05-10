// GlobalTimeStage: device-wide daily time limit adjust. Mirrors
// ContentTimeStage but writes to the global override slot instead
// of a per-item one.
//
// Two modes depending on whether the server has a daily limit
// configured:
//
//   Server limit configured (time.enabled === true):
//     "+N minutes" rows ADD to the existing bucket (existing
//     behavior). "Reset" clears the override; "no limit until
//     tomorrow" suspends.
//
//   No server-side limit:
//     "+N minutes" rows SET an absolute budget for today (so the
//     parent can introduce a one-off cap of e.g. 30m on a random
//     Tuesday without flipping the global feature on). The
//     effective-status merge in kidStatus.ts treats the override
//     as the authoritative budget when server reports
//     enabled=false.

import * as overrides from "../parentOverrides";
import { nextLocalMidnight } from "../parentOverrides";
import { useTimeStatus } from "../kidStatus";
import { DurationPickerView } from "./DurationPicker";
import {
    ADJUST_TIME,
    type AdjustOpt,
    formatExpiresShort,
} from "./durations";
import type { StageCtx } from "./types";

type Props = {
    ctx: StageCtx;
};

export function GlobalTimeStage({ ctx }: Props) {
    const time = useTimeStatus();
    const serverEnabled = !!time?.enabled;
    const title = serverEnabled
        ? "Adjust daily time limit"
        : "Set daily time limit (today only)";
    return (
        <DurationPickerView
            title={title}
            options={ADJUST_TIME}
            onBack={ctx.pop}
            onPick={(opt) => {
                const adj = opt as AdjustOpt;
                if (adj.clear) {
                    overrides.clearGlobalTime();
                    ctx.replaceTop({
                        kind: "done",
                        message: "Daily-limit override cleared.",
                    });
                    return;
                }
                if (adj.untilMidnight) {
                    const until = nextLocalMidnight();
                    overrides.setGlobalTime({
                        disabledUntil: until,
                        expiresAt: until,
                    });
                    ctx.replaceTop({
                        kind: "done",
                        message: `Unlimited until ${formatExpiresShort(until)}.`,
                    });
                    return;
                }
                if (!adj.addedMinutes) return;
                const expiresAt = nextLocalMidnight();
                if (!serverEnabled) {
                    // Override-only path: set the absolute budget
                    // for today. Stack picks (e.g. tap +15m twice
                    // -> 30m total).
                    const prev =
                        overrides.getGlobalTime()?.setMinutesRemaining ?? 0;
                    overrides.setGlobalTime({
                        setMinutesRemaining: prev + adj.addedMinutes,
                        expiresAt,
                    });
                    ctx.replaceTop({
                        kind: "done",
                        message: `${prev + adj.addedMinutes}m of TV today.`,
                    });
                    return;
                }
                overrides.setGlobalTime({
                    addedMinutes:
                        (overrides.getGlobalTime()?.addedMinutes ?? 0) +
                        adj.addedMinutes,
                    expiresAt,
                });
                ctx.replaceTop({
                    kind: "done",
                    message: `+${adj.addedMinutes}m to today's daily limit.`,
                });
            }}
        />
    );
}
