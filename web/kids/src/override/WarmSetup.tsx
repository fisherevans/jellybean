// WarmSetupStage: thin wrapper over ViewingSetupView for the
// red-shift / warming control. See DimSetup.tsx for the rationale
// behind the dim/warm split.

import { ViewingSetupView } from "./ViewingSetup";
import type { StageCtx } from "./types";

type Props = {
    ctx: StageCtx;
};

export function WarmSetupStage({ ctx }: Props) {
    return (
        <ViewingSetupView
            control="warm"
            onBack={ctx.pop}
            onDone={(msg) => ctx.replaceTop({ kind: "done", message: msg })}
        />
    );
}
