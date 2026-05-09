// ModePickerStage: list of available modes from the server. Pick
// one to advance to ModeDuration (set intent). Doubles as the
// ModeDuration entry as well — the duration picker stage is just
// DurationPickerView wrapped in a small commit handler that lives
// in the host (it spans both "set" and "disable" intents).

import { useActiveMode } from "../kidStatus";
import { ActionList, BackLink, ModalShell } from "./shell";
import type { StageCtx } from "./types";

type Props = {
    ctx: StageCtx;
    token: string;
};

export function ModePickerStage({ ctx, token }: Props) {
    const mode = useActiveMode();
    const available = mode?.available ?? (mode?.mode ? [mode.mode] : []);
    if (available.length === 0) {
        return (
            <ModalShell title="No modes configured">
                <p className="muted">No modes have been set up.</p>
                <BackLink autoFocus onActivate={ctx.pop} />
            </ModalShell>
        );
    }
    return (
        <ModalShell title="Pick a mode">
            <ActionList
                items={available.map((m) => ({
                    key: String(m.id),
                    label: m.name,
                    onActivate: () =>
                        ctx.push({
                            kind: "modeDuration",
                            token,
                            intent: "set",
                            modeId: m.id,
                            modeName: m.name,
                        }),
                }))}
            />
            <BackLink onActivate={ctx.pop} />
        </ModalShell>
    );
}
