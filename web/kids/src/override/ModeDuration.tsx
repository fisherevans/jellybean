// ModeDurationStage: duration picker for the "turn on mode for…"
// and "disable mode for…" intents. Wraps DurationPickerView with
// the commit handler that routes set vs disable to the right
// parentOverrides call.

import * as overrides from "../parentOverrides";
import { DurationPickerView } from "./DurationPicker";
import { DUR_LONG, type DurationOpt, formatExpiresShort } from "./durations";
import type { StageCtx } from "./types";

type Props = {
    ctx: StageCtx;
    intent: "set" | "disable";
    modeId?: number;
    modeName?: string;
};

export function ModeDurationStage({
    ctx,
    intent,
    modeId,
    modeName,
}: Props) {
    const title =
        intent === "disable"
            ? `Disable ${modeName ?? "mode"} for…`
            : `Turn on ${modeName ?? "mode"} for…`;
    return (
        <DurationPickerView
            title={title}
            options={DUR_LONG}
            onBack={ctx.pop}
            onPick={(opt) => {
                // DUR_LONG is DurationOpt[]; the generic
                // picker types its callback as the union.
                const expiresAt = (opt as DurationOpt).resolve();
                if (intent === "disable") {
                    overrides.setMode({ action: "disable", expiresAt });
                    ctx.replaceTop({
                        kind: "done",
                        message: `Mode disabled until ${formatExpiresShort(expiresAt)}.`,
                    });
                } else if (modeId !== undefined) {
                    overrides.setMode({
                        action: "set",
                        modeId,
                        expiresAt,
                    });
                    ctx.replaceTop({
                        kind: "done",
                        message: `${modeName ?? "Mode"} on until ${formatExpiresShort(expiresAt)}.`,
                    });
                }
            }}
        />
    );
}
