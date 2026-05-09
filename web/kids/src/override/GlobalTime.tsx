// GlobalTimeStage: device-wide daily time limit adjust. Mirrors
// ContentTimeStage but writes to the global override slot instead
// of a per-item one.

import * as overrides from "../parentOverrides";
import { nextLocalMidnight } from "../parentOverrides";
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
    return (
        <DurationPickerView
            title="Adjust daily time limit"
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
