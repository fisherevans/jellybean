import { useMemo } from "react";
import KidModalShell from "./KidModalShell";
import { useDpadCursor } from "./useDpadCursor";

// OptionPickerModal is the shared "pick one of N values" modal used
// by Library + TagDetail for the Filter and Sort dropdown buttons.
// Vertical stack of options on a white card; visually mirrors
// AlphaPickerModal but with a single-column list. Portal +
// keyboard plumbing + focus trap live in KidModalShell;
// useDpadCursor owns the cursor + Up/Down/Enter listener.

export type OptionPickerOption = {
    id: string;
    label: string;
};

type Props = {
    title: string;
    options: OptionPickerOption[];
    currentId: string;
    onSelect: (id: string) => void;
    onClose: () => void;
};

export default function OptionPickerModal({
    title,
    options,
    currentId,
    onSelect,
    onClose,
}: Props) {
    // Initial cursor: the currently-selected option, falling back
    // to 0 if the saved value isn't in the list (defensive against
    // stale localStorage values).
    const initialCursor = useMemo(() => {
        const i = options.findIndex((o) => o.id === currentId);
        return i >= 0 ? i : 0;
    }, [options, currentId]);

    return (
        <KidModalShell
            onClose={onClose}
            ariaLabel={title}
            backdropClassName="alpha-picker-backdrop"
            cardClassName="alpha-picker-card option-picker-card"
        >
            <OptionPickerBody
                title={title}
                options={options}
                currentId={currentId}
                initialCursor={initialCursor}
                onSelect={onSelect}
            />
        </KidModalShell>
    );
}

// OptionPickerBody lives inside KidModalShell so useDpadCursor reads
// the shell's KidModalArmedContext correctly (provider wraps the
// portal children, not the shell's caller).
function OptionPickerBody({
    title,
    options,
    currentId,
    initialCursor,
    onSelect,
}: {
    title: string;
    options: OptionPickerOption[];
    currentId: string;
    initialCursor: number;
    onSelect: (id: string) => void;
}) {
    const dpad = useDpadCursor({
        count: options.length,
        initial: initialCursor,
        onActivate: (i) => {
            const opt = options[i];
            if (opt) onSelect(opt.id);
        },
    });

    return (
        <>
            <h2 className="alpha-picker-title">{title}</h2>
            <div className="option-picker-list">
                {options.map((opt, i) => {
                    const focused = dpad.cursor === i;
                    const isCurrent = opt.id === currentId;
                    return (
                        <button
                            key={opt.id}
                            ref={dpad.register(i) as (
                                el: HTMLButtonElement | null,
                            ) => void}
                            type="button"
                            className={`option-picker-item ${
                                isCurrent ? "current" : ""
                            } ${focused ? "focused" : ""}`}
                            onClick={() => onSelect(opt.id)}
                            onFocus={() => dpad.setCursor(i)}
                            tabIndex={focused ? 0 : -1}
                            aria-pressed={isCurrent}
                        >
                            <span className="option-picker-label">
                                {opt.label}
                            </span>
                            {isCurrent && (
                                <span
                                    className="option-picker-check"
                                    aria-hidden
                                >
                                    ✓
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>
            <p className="alpha-picker-hint" aria-hidden>
                Back to close
            </p>
        </>
    );
}
