// ModeActionStage: split point for "disable current mode" vs
// "turn on a different mode". The currently-active mode (if any)
// is read from the kidStatus hook so the disable row knows the
// mode's name.

import { useActiveMode } from "../kidStatus";
import { ActionList, BackLink, ModalShell } from "./shell";
import type { StageCtx } from "./types";

type Props = {
    ctx: StageCtx;
    token: string;
};

export function ModeActionStage({ ctx, token }: Props) {
    const mode = useActiveMode();
    const active = mode?.mode;
    const items: { key: string; label: string; onActivate: () => void }[] = [];
    if (active) {
        items.push({
            key: "disable",
            label: `Disable ${active.name}`,
            onActivate: () =>
                ctx.push({
                    kind: "modeDuration",
                    token,
                    intent: "disable",
                    modeName: active.name,
                }),
        });
    }
    items.push({
        key: "turn-on",
        label: active ? "Switch to a different mode" : "Turn on a mode",
        onActivate: () => ctx.push({ kind: "modePicker", token }),
    });
    return (
        <ModalShell
            title="Mode override"
            subtitle={active ? `Currently ${active.name}` : "No mode active"}
        >
            <ActionList items={items} />
            <BackLink onActivate={ctx.pop} />
        </ModalShell>
    );
}
