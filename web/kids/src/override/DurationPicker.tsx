// DurationPicker: shared "pick a duration / adjust" stage backed
// by either DUR_LONG (mode / dim / warm timeouts) or ADJUST_TIME /
// ADJUST_BREAKS (time-limit + body-break adjust rows). Pickers
// only differ by their option list and their onPick handler, so
// one component covers all variants.

import { ActionList, BackLink, ModalShell } from "./shell";
import type { AdjustOpt, DurationOpt } from "./durations";

type DurationPickerProps = {
    title: string;
    options: { id: string; label: string }[];
    onBack: () => void;
    onPick: (option: DurationOpt | AdjustOpt) => void;
};

export function DurationPickerView({
    title,
    options,
    onBack,
    onPick,
}: DurationPickerProps) {
    return (
        <ModalShell title={title}>
            <ActionList
                items={options.map((o) => ({
                    key: o.id,
                    label: o.label,
                    onActivate: () =>
                        onPick(o as DurationOpt | AdjustOpt),
                }))}
            />
            <BackLink onActivate={onBack} />
        </ModalShell>
    );
}
