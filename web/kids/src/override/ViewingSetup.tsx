// ViewingSetupView: shared render for the dim and warm override
// stages. Slider (Left/Right by 5%) over a live preview, plus a
// duration list; commit writes through parentOverrides and emits
// a "Done" message via onDone.
//
// Kept distinct from the rest of the per-stage files because both
// DimSetup and WarmSetup defer to it — duplicating ~150 lines of
// preview pipeline once per control wouldn't be worth the
// stage-file granularity.

import { useEffect, useRef, useState } from "react";
import * as overrides from "../parentOverrides";
import { useViewingState } from "../kidStatus";
import { ActionList, BackLink, ModalShell } from "./shell";
import {
    DUR_LONG,
    type DurationOpt,
    formatExpiresShort,
} from "./durations";

// Hard ceiling for dim: the kid TV's WebView can't easily recover
// from a fully-dimmed screen (no obvious affordance for "you set
// dim to 100, undo it"). Cap at 90 so something is always visible.
const DIM_MAX_PERCENT = 90;
const WARM_MAX_PERCENT = 100;

type Props = {
    control: "dim" | "warm";
    onBack: () => void;
    onDone: (message: string) => void;
};

export function ViewingSetupView({ control, onBack, onDone }: Props) {
    const viewing = useViewingState();
    const maxPercent =
        control === "dim" ? DIM_MAX_PERCENT : WARM_MAX_PERCENT;
    // Initial value: existing local override if present, else
    // server-reported (clamped to the new ceiling so a previously
    // saved >90% dim doesn't load past the cap).
    const existing =
        control === "dim" ? overrides.getDim() : overrides.getWarm();
    const [percent, setPercent] = useState<number>(() => {
        const initial = existing
            ? existing.percent
            : control === "dim"
              ? (viewing?.dimPercent ?? 0)
              : (viewing?.warmTintPercent ?? 0);
        return Math.min(maxPercent, Math.max(0, initial));
    });

    // Slider: focus on it by default. ArrowLeft/Right adjust by
    // 5%. ArrowDown hands focus to the first duration option so
    // the kid can pick a duration without the mouse.
    const sliderRef = useRef<HTMLDivElement | null>(null);
    const durationListRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        sliderRef.current?.focus();
    }, []);

    function focusFirstDuration() {
        const btn = durationListRef.current?.querySelector("button");
        if (btn instanceof HTMLButtonElement) btn.focus();
    }

    function onSliderKey(e: React.KeyboardEvent) {
        if (e.key === "ArrowLeft") {
            e.preventDefault();
            setPercent((p) => Math.max(0, p - 5));
            return;
        }
        if (e.key === "ArrowRight") {
            e.preventDefault();
            setPercent((p) => Math.min(maxPercent, p + 5));
            return;
        }
        if (e.key === "ArrowDown") {
            e.preventDefault();
            focusFirstDuration();
            return;
        }
    }

    // For preview: combine THIS slider's percent with the OTHER
    // control's effective value (server + local override).
    const previewDim =
        control === "dim"
            ? percent
            : (overrides.getDim()?.percent ?? viewing?.dimPercent ?? 0);
    const previewWarm =
        control === "warm"
            ? percent
            : (overrides.getWarm()?.percent ?? viewing?.warmTintPercent ?? 0);
    // Mirror admin/src/ViewingPreview.tsx's filter + multiply-blend
    // overlay pipeline so dim and warm look the same in both
    // surfaces. Asset served from /player/viewing-preview.jpg
    // (kid app's own copy of the admin's preview JPG).
    const dimFilter = `brightness(${1 - previewDim / 100})`;
    const warmFilter = (() => {
        const r = Math.max(0, Math.min(1, previewWarm / 100));
        return `sepia(${0.7 * r}) saturate(${1 + 1.3 * r}) hue-rotate(${-20 * r}deg) contrast(${1 + 0.05 * r})`;
    })();
    const warmOverlay = (() => {
        const r = Math.max(0, Math.min(1, previewWarm / 100));
        return {
            background: "rgb(255, 140, 55)",
            mixBlendMode: "multiply" as const,
            opacity: r * 0.42,
        };
    })();

    function commitWith(d: DurationOpt) {
        const expiresAt = d.resolve();
        if (control === "dim") {
            overrides.setDim({ percent, expiresAt });
        } else {
            overrides.setWarm({ percent, expiresAt });
        }
        onDone(
            `${control === "dim" ? "Dim" : "Warm"} ${percent}% until ${formatExpiresShort(expiresAt)}.`,
        );
    }

    return (
        <ModalShell
            title={control === "dim" ? "Override dimming" : "Override warming"}
        >
            <div
                ref={sliderRef}
                tabIndex={0}
                role="slider"
                aria-label={control === "dim" ? "Dim percent" : "Warm percent"}
                aria-valuemin={0}
                aria-valuemax={maxPercent}
                aria-valuenow={percent}
                className="override-slider"
                onKeyDown={onSliderKey}
            >
                <div
                    className="override-slider-fill"
                    style={{ width: `${(percent / maxPercent) * 100}%` }}
                />
                <div className="override-slider-label">{percent}%</div>
            </div>
            <div className="override-preview" aria-hidden>
                <div
                    className="override-preview-bezel"
                    style={{ filter: dimFilter }}
                >
                    <div className="override-preview-frame">
                        <img
                            src="/player/viewing-preview.jpg"
                            alt=""
                            className="override-preview-img"
                            style={{ filter: warmFilter }}
                        />
                        <div
                            className="override-preview-warm"
                            style={warmOverlay}
                        />
                    </div>
                </div>
            </div>
            <p className="muted">Pick how long:</p>
            <ActionList
                listRef={durationListRef}
                noAutoFocus
                onExitUp={() => sliderRef.current?.focus()}
                items={DUR_LONG.map((d) => ({
                    key: d.id,
                    label: d.label,
                    onActivate: () => commitWith(d),
                }))}
            />
            <BackLink onActivate={onBack} />
        </ModalShell>
    );
}
