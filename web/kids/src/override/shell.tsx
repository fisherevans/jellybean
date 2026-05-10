// Reusable building blocks shared across every override stage.
//
//   ModalShell — portaled backdrop + adult palette + focus trap.
//   ActionList — vertical D-pad-friendly button list.
//   BackLink   — low-chrome footer "Back" / "Done" link.
//
// Each stage composes these with its own content. The host
// (OverrideModal.tsx) does NOT import from any per-stage file, only
// from this shell — and per-stage files do not import each other.

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { IconArrowLeft } from "./icons";

// ============================================================
// ModalShell
// ============================================================

type ModalShellProps = {
    title: string;
    subtitle?: string;
    children: React.ReactNode;
};

export function ModalShell({ title, subtitle, children }: ModalShellProps) {
    // Portal to document.body so a `transform`-bearing ancestor
    // doesn't re-anchor our `position: fixed` backdrop.
    // .kids-override-adult applies the dark/desaturated palette
    // that distinguishes this modal from the kid app.
    const modalRef = useRef<HTMLDivElement | null>(null);
    const lastInsideRef = useRef<HTMLElement | null>(null);

    // Focus trap: on desktop the parent might click outside the
    // modal (selecting body / the backdrop). The keyboard then has
    // no focus target inside the modal, so D-pad / arrow keys do
    // nothing. Snap focus back to the last-known-inside element
    // (or the modal root) whenever focus drifts out. focusin
    // bubbles, so we install one listener on document.
    useEffect(() => {
        function onFocusIn(e: FocusEvent) {
            const target = e.target as HTMLElement | null;
            const root = modalRef.current;
            if (!root) return;
            if (target && root.contains(target)) {
                lastInsideRef.current = target;
                return;
            }
            // Focus left the modal. Restore the last-known
            // focusable, or the first focusable, or the root
            // itself (which has tabIndex=-1) so subsequent arrow
            // keys reach the modal again.
            const restore =
                lastInsideRef.current && root.contains(lastInsideRef.current)
                    ? lastInsideRef.current
                    : root.querySelector<HTMLElement>(
                          'button, [tabindex]:not([tabindex="-1"])',
                      );
            (restore ?? root).focus();
        }
        // Mousedown on the backdrop: prevent the default
        // body-becomes-active behavior so the focus we just had
        // inside the modal survives the click. Without this,
        // clicking the dim area pulls focus to body BEFORE our
        // focusin restore can run, producing a single-frame
        // flicker on slow devices.
        function onBackdropMouseDown(e: MouseEvent) {
            const root = modalRef.current;
            if (!root) return;
            if (root.contains(e.target as Node)) return;
            e.preventDefault();
        }
        document.addEventListener("focusin", onFocusIn);
        document.addEventListener("mousedown", onBackdropMouseDown);
        return () => {
            document.removeEventListener("focusin", onFocusIn);
            document.removeEventListener("mousedown", onBackdropMouseDown);
        };
    }, []);

    return createPortal(
        <div className="override-backdrop kids-override-adult">
            <div
                ref={modalRef}
                className="override-modal"
                tabIndex={-1}
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-label={title}
            >
                <h2>{title}</h2>
                {subtitle && <p className="override-subtitle">{subtitle}</p>}
                {children}
            </div>
        </div>,
        document.body,
    );
}

// ============================================================
// ActionList
// ============================================================

export type ActionItem = {
    key: string;
    label: string;
    onActivate: () => void;
    disabled?: boolean;
    selected?: boolean;
    autoFocus?: boolean;
    danger?: boolean;
};

// ActionList: vertical D-pad-friendly button list. Up / Down to
// move cursor; Enter activates focused row. Each rendered <button>
// uses native focus (Up/Down ArrowUp/Down move focus rather than
// installing yet another window listener), so the parent stage's
// useProgressiveBack still owns Back. The first row gets DOM
// focus on mount unless an item explicitly carries autoFocus,
// OR `noAutoFocus` is set (used when the parent stage owns the
// initial focus target - e.g. a dim/warm slider above the list).
//
// onExitUp / onExitDown let the parent compose multiple lists +
// non-list focusables (slider, shift card) into one menu by
// catching ArrowUp at the first row / ArrowDown at the last.
export type ActionListProps = {
    items: ActionItem[];
    noAutoFocus?: boolean;
    onExitUp?: () => void;
    onExitDown?: () => void;
    listRef?: React.RefObject<HTMLDivElement>;
};

export function ActionList({
    items,
    noAutoFocus,
    onExitUp,
    onExitDown,
    listRef,
}: ActionListProps) {
    const refs = useRef<(HTMLButtonElement | null)[]>([]);
    useEffect(() => {
        if (noAutoFocus) return;
        const target =
            items.findIndex((it) => it.autoFocus && !it.disabled);
        const idx = target >= 0
            ? target
            : items.findIndex((it) => !it.disabled);
        if (idx >= 0) refs.current[idx]?.focus();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    function focusSibling(direction: "next" | "prev") {
        // Fallback when the parent didn't provide an explicit
        // onExitUp/Down: walk the modal's focusable siblings in DOM
        // order and land on the closest one outside this list. This
        // is what makes the BackLink "Back" / "Done" footer reachable
        // by D-pad without every caller threading a ref through.
        const anchor = refs.current.find(Boolean);
        const root = (anchor?.closest(".override-modal") ??
            document.body) as HTMLElement;
        const all = Array.from(
            root.querySelectorAll<HTMLElement>(
                'button, [tabindex]:not([tabindex="-1"])',
            ),
        ).filter((el) => !(el as HTMLButtonElement).disabled);
        const ours = new Set(refs.current.filter(Boolean) as HTMLElement[]);
        // Find an "anchor" element in this list to know our position
        // in the global order.
        const anchorIdx = all.findIndex((el) => ours.has(el));
        if (anchorIdx < 0) return;
        if (direction === "next") {
            for (let k = anchorIdx + 1; k < all.length; k++) {
                if (!ours.has(all[k])) {
                    all[k].focus();
                    return;
                }
            }
        } else {
            for (let k = anchorIdx - 1; k >= 0; k--) {
                if (!ours.has(all[k])) {
                    all[k].focus();
                    return;
                }
            }
        }
    }
    function onKeyDown(i: number, e: React.KeyboardEvent) {
        if (e.key === "ArrowDown") {
            e.preventDefault();
            for (let j = i + 1; j < items.length; j++) {
                if (!items[j].disabled) {
                    refs.current[j]?.focus();
                    return;
                }
            }
            // Already on the last enabled row - hand focus off to
            // the parent's explicit callback, else fall through to
            // the next focusable sibling (BackLink, etc).
            if (onExitDown) {
                onExitDown();
                return;
            }
            focusSibling("next");
            return;
        }
        if (e.key === "ArrowUp") {
            e.preventDefault();
            for (let j = i - 1; j >= 0; j--) {
                if (!items[j].disabled) {
                    refs.current[j]?.focus();
                    return;
                }
            }
            if (onExitUp) {
                onExitUp();
                return;
            }
            focusSibling("prev");
            return;
        }
    }
    return (
        <div className="override-action-list" ref={listRef}>
            {items.map((it, i) => (
                <button
                    key={it.key}
                    ref={(el) => (refs.current[i] = el)}
                    type="button"
                    className={`override-action ${it.selected ? "selected" : ""} ${it.danger ? "danger" : ""}`}
                    disabled={it.disabled}
                    onClick={it.onActivate}
                    onKeyDown={(e) => onKeyDown(i, e)}
                >
                    {it.label}
                </button>
            ))}
        </div>
    );
}

// ============================================================
// BackLink
// ============================================================

// BackLink: low-chrome footer that the parent visits with the
// D-pad. Renders as text + arrow icon, no full button bezel; the
// focus ring is a 1px border around the inline text. Used in
// place of ActionButton for back / done footers across the
// override views per the M9 v2 visual brief.
//
// Pass `buttonRef` to let the parent stage steer D-pad focus down
// onto the link from the last item in its body (e.g. MenuView
// hands ArrowDown from the bottom row to the "Done" footer so the
// label isn't a phantom selectable). Pass `onKeyDown` when the
// stage wants to handle ArrowUp from the link to bounce focus back
// up into the body.
export function BackLink({
    onActivate,
    label = "Back",
    autoFocus,
    disabled,
    icon,
    buttonRef,
    onKeyDown,
}: {
    onActivate: () => void;
    label?: string;
    autoFocus?: boolean;
    disabled?: boolean;
    /** Override the default left-arrow glyph. Pass null to omit. */
    icon?: React.ReactNode | null;
    buttonRef?: React.MutableRefObject<HTMLButtonElement | null>;
    onKeyDown?: (e: React.KeyboardEvent<HTMLButtonElement>) => void;
}) {
    const localRef = useRef<HTMLButtonElement | null>(null);
    const setRef = (el: HTMLButtonElement | null) => {
        localRef.current = el;
        if (buttonRef) buttonRef.current = el;
    };
    useEffect(() => {
        if (autoFocus) localRef.current?.focus();
    }, [autoFocus]);
    const glyph = icon === undefined ? <IconArrowLeft /> : icon;
    // Default ArrowUp handler: walk DOM-backwards to the previous
    // focusable inside the modal so the parent can reverse out of
    // BackLink without losing focus into the void. The caller's
    // onKeyDown (when supplied) wins so MenuView etc can override.
    function defaultKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
        if (onKeyDown) {
            onKeyDown(e);
            if (e.defaultPrevented) return;
        }
        if (e.key === "ArrowUp") {
            e.preventDefault();
            const root = localRef.current?.closest(
                ".override-modal",
            ) as HTMLElement | null;
            if (!root) return;
            const all = Array.from(
                root.querySelectorAll<HTMLElement>(
                    'button, [tabindex]:not([tabindex="-1"])',
                ),
            ).filter((el) => !(el as HTMLButtonElement).disabled);
            const me = localRef.current;
            const idx = me ? all.indexOf(me) : -1;
            if (idx > 0) all[idx - 1].focus();
        }
    }
    return (
        <button
            ref={setRef}
            type="button"
            className="override-back-link"
            disabled={disabled}
            onClick={onActivate}
            onKeyDown={defaultKeyDown}
        >
            {glyph && <span className="override-back-link-icon">{glyph}</span>}
            <span>{label}</span>
        </button>
    );
}
