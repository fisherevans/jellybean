// ContentTimeStage: per-item time-limit adjust. +N minutes / reset /
// no-limit-until-tomorrow. Writes through parentOverrides; the
// kid's effective-status hooks merge it on top of server state.

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
    itemId: string;
    itemName: string;
};

export function ContentTimeStage({ ctx, itemId, itemName }: Props) {
    return (
        <DurationPickerView
            title={`Adjust time limit for ${itemName}`}
            options={ADJUST_TIME}
            onBack={ctx.pop}
            onPick={(opt) => {
                const adj = opt as AdjustOpt;
                if (adj.clear) {
                    overrides.clearContentTime(itemId);
                    ctx.replaceTop({
                        kind: "done",
                        message: `Time-limit override cleared for ${itemName}.`,
                    });
                    return;
                }
                if (adj.untilMidnight) {
                    const until = nextLocalMidnight();
                    overrides.setContentTime(itemId, {
                        disabledUntil: until,
                        expiresAt: until,
                    });
                    ctx.replaceTop({
                        kind: "done",
                        message: `${itemName} unlimited until ${formatExpiresShort(until)}.`,
                    });
                    return;
                }
                if (!adj.addedMinutes) return;
                const expiresAt = nextLocalMidnight();
                overrides.setContentTime(itemId, {
                    addedMinutes:
                        (overrides.getContentTime(itemId)?.addedMinutes ?? 0) +
                        adj.addedMinutes,
                    expiresAt,
                });
                ctx.replaceTop({
                    kind: "done",
                    message: `+${adj.addedMinutes}m for ${itemName} (today).`,
                });
            }}
        />
    );
}
