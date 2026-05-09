// Long-press hook used by Browse / Library / TagDetail / Watch.
// Detects short vs long Enter (D-pad center) on the focused tile
// and dispatches to onShortPress (play) or onLongPress (open the
// adult override modal). Capture-phase + preventDefault so the
// page's own Enter handler doesn't double-fire.
//
// e.repeat is swallowed: held Enter doesn't re-arm.
//
// Re-exported from OverrideModal.tsx for back-compat with existing
// import sites; new call sites can import directly from here.

import { useEffect, useRef } from "react";

export function useLongPressEnter({
    enabled,
    onShortPress,
    onLongPress,
    longPressMs = 1000,
}: {
    enabled: boolean;
    onShortPress?: () => void;
    onLongPress: () => void;
    longPressMs?: number;
}): void {
    const timerRef = useRef<number | null>(null);
    const firedRef = useRef(false);
    const armedRef = useRef(false);
    const onShortRef = useRef(onShortPress);
    const onLongRef = useRef(onLongPress);
    onShortRef.current = onShortPress;
    onLongRef.current = onLongPress;
    useEffect(() => {
        if (!enabled) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            e.stopPropagation();
            if (e.repeat) return;
            if (armedRef.current) return;
            armedRef.current = true;
            firedRef.current = false;
            timerRef.current = window.setTimeout(() => {
                timerRef.current = null;
                firedRef.current = true;
                // Drop DOM focus before invoking onLongPress: the
                // parent re-renders + this hook unbinds; if the
                // kid is still holding Enter, the eventual keyup
                // synthesizes a click on the focused button.
                // Blurring sends the click to body (no-op).
                const active = document.activeElement;
                if (active instanceof HTMLElement && active !== document.body) {
                    active.blur();
                }
                onLongRef.current();
            }, longPressMs);
        };
        const onKeyUp = (e: KeyboardEvent) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            e.stopPropagation();
            if (!armedRef.current) return;
            armedRef.current = false;
            if (timerRef.current !== null) {
                window.clearTimeout(timerRef.current);
                timerRef.current = null;
            }
            if (firedRef.current) {
                firedRef.current = false;
                return;
            }
            onShortRef.current?.();
        };
        window.addEventListener("keydown", onKeyDown, { capture: true });
        window.addEventListener("keyup", onKeyUp, { capture: true });
        return () => {
            window.removeEventListener("keydown", onKeyDown, { capture: true });
            window.removeEventListener("keyup", onKeyUp, { capture: true });
            if (timerRef.current !== null) {
                window.clearTimeout(timerRef.current);
                timerRef.current = null;
            }
            armedRef.current = false;
            firedRef.current = false;
        };
    }, [enabled, longPressMs]);
}
