// BodyBreaksStage: pause body breaks for a configurable window or
// clear an existing override. Shares the AdjustOpt-style picker
// with the time-limit stages.

import * as overrides from "../parentOverrides";
import { expiresFromMinutes, nextLocalMidnight } from "../parentOverrides";
import { DurationPickerView } from "./DurationPicker";
import {
    ADJUST_BREAKS,
    type AdjustOpt,
    formatExpiresShort,
} from "./durations";
import type { StageCtx } from "./types";

type Props = {
    ctx: StageCtx;
};

export function BodyBreaksStage({ ctx }: Props) {
    return (
        <DurationPickerView
            title="Disable body breaks…"
            options={ADJUST_BREAKS}
            onBack={ctx.pop}
            onPick={(opt) => {
                const adj = opt as AdjustOpt;
                if (adj.clear) {
                    overrides.clearBodyBreaks();
                    ctx.replaceTop({
                        kind: "done",
                        message: "Body break override cleared.",
                    });
                    return;
                }
                let until: string;
                if (adj.untilMidnight) {
                    until = nextLocalMidnight();
                } else if (adj.addedMinutes) {
                    until = expiresFromMinutes(adj.addedMinutes);
                } else {
                    return;
                }
                overrides.setBodyBreaks({ disabledUntil: until });
                ctx.replaceTop({
                    kind: "done",
                    message: `Body breaks paused until ${formatExpiresShort(until)}.`,
                });
            }}
        />
    );
}
