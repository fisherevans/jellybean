// DimSetupStage: thin wrapper over ViewingSetupView for the
// brightness-dim control. Splitting dim and warm into distinct
// stages keeps the host's render branch trivial; the shared
// preview pipeline lives in ViewingSetup.tsx.

import { ViewingSetupView } from "./ViewingSetup";
import type { StageCtx } from "./types";

type Props = {
    ctx: StageCtx;
};

export function DimSetupStage({ ctx }: Props) {
    return (
        <ViewingSetupView
            control="dim"
            onBack={ctx.pop}
            onDone={(msg) => ctx.replaceTop({ kind: "done", message: msg })}
        />
    );
}
