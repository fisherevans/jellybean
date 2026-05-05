import { useEffect, useRef } from "react";

// Four-square PIN input. Each digit gets its own visible cell;
// keyboard input fills left-to-right, backspace deletes back to the
// previous cell, paste of a 4-digit code distributes across cells.

type Props = {
    value: string;
    onChange: (next: string) => void;
    onComplete?: (full: string) => void;
    disabled?: boolean;
    autoFocus?: boolean;
};

const LENGTH = 4;

export default function PinInput({
    value,
    onChange,
    onComplete,
    disabled,
    autoFocus,
}: Props) {
    const inputs = useRef<Array<HTMLInputElement | null>>([]);

    useEffect(() => {
        if (autoFocus) inputs.current[0]?.focus();
    }, [autoFocus]);

    function setCharAt(idx: number, ch: string): string {
        const arr = value.padEnd(LENGTH).split("");
        arr[idx] = ch;
        return arr.join("").trimEnd();
    }

    function onChangeAt(idx: number, raw: string) {
        const digit = raw.replace(/\D/g, "").slice(-1);
        if (!digit) return;
        const next = setCharAt(idx, digit).slice(0, LENGTH);
        onChange(next);
        if (idx < LENGTH - 1) {
            inputs.current[idx + 1]?.focus();
            inputs.current[idx + 1]?.select();
        } else if (next.length === LENGTH && onComplete) {
            onComplete(next);
        }
    }

    function onKeyDownAt(idx: number, e: React.KeyboardEvent<HTMLInputElement>) {
        if (e.key === "Backspace") {
            if (value[idx]) {
                e.preventDefault();
                const next = setCharAt(idx, " ").trimEnd();
                onChange(next);
            } else if (idx > 0) {
                e.preventDefault();
                const prev = inputs.current[idx - 1];
                if (prev) {
                    const next = setCharAt(idx - 1, " ").trimEnd();
                    onChange(next);
                    prev.focus();
                }
            }
        } else if (e.key === "ArrowLeft" && idx > 0) {
            e.preventDefault();
            inputs.current[idx - 1]?.focus();
            inputs.current[idx - 1]?.select();
        } else if (e.key === "ArrowRight" && idx < LENGTH - 1) {
            e.preventDefault();
            inputs.current[idx + 1]?.focus();
            inputs.current[idx + 1]?.select();
        }
    }

    function onPasteAt(idx: number, e: React.ClipboardEvent<HTMLInputElement>) {
        const text = e.clipboardData.getData("text").replace(/\D/g, "");
        if (text.length === 0) return;
        e.preventDefault();
        const arr = value.padEnd(LENGTH).split("");
        for (let i = 0; i < text.length && idx + i < LENGTH; i++) {
            arr[idx + i] = text[i];
        }
        const next = arr.join("").trimEnd().slice(0, LENGTH);
        onChange(next);
        const lastIdx = Math.min(idx + text.length, LENGTH - 1);
        inputs.current[lastIdx]?.focus();
        if (next.length === LENGTH && onComplete) onComplete(next);
    }

    return (
        <div className="pin-input" role="group" aria-label="PIN">
            {Array.from({ length: LENGTH }, (_, i) => (
                <input
                    key={i}
                    ref={(el) => {
                        inputs.current[i] = el;
                    }}
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={1}
                    value={value[i] ?? ""}
                    disabled={disabled}
                    onChange={(e) => onChangeAt(i, e.target.value)}
                    onKeyDown={(e) => onKeyDownAt(i, e)}
                    onPaste={(e) => onPasteAt(i, e)}
                    onFocus={(e) => e.currentTarget.select()}
                    className="pin-input-cell"
                    aria-label={`Digit ${i + 1}`}
                />
            ))}
        </div>
    );
}
