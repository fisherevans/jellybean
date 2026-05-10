// MenuView + MenuSections: the post-PIN menu. Two halves:
//
//   1. "Manage <item>"   - persistent edits to the focused item
//      (tags, hide, mark watched/unwatched, per-content time
//      limit). Episodes / seasons scope to the parent series.
//
//   2. "System"          - device-local runtime overrides (mode,
//      dim, warm, global time, body breaks, auto-off).
//
// MenuSections renders flat MenuRows under their section heading
// and owns the focus grid: Up/Down crosses sections, Left/Right
// hops between a row's primary button and its paired reset
// button (used when an override is currently active and the
// parent wants to clear it without leaving the menu).

import { useEffect, useRef } from "react";
import * as overrides from "../parentOverrides";
import { useParentOverride } from "../parentOverrides";
import {
    summarizeAutoOff,
    summarizeBodyBreaks,
    summarizeGlobalTime,
    summarizeMode,
    summarizeViewingPercent,
    useActiveMode,
    useBodyBreakStatus,
    useEffectiveTimeStatus,
    useTimeStatus,
    useViewingState,
} from "../kidStatus";
import { BackLink, ModalShell } from "./shell";
import {
    IconAutoOff,
    IconBreak,
    IconCheck,
    IconClock,
    IconDim,
    IconHide,
    IconMode,
    IconTag,
    IconUncheck,
    IconWarm,
} from "./icons";
import type { StageCtx } from "./types";

type MenuRow = {
    key: string;
    icon: React.ReactNode;
    label: string;
    /** Optional one-line muted sub-text rendered under the action
     *  label. Used by the system-section rows to surface the
     *  feature's current effective state ("Off", "9:00pm", "30m
     *  left today (override)", etc.) so the parent can read what's
     *  happening before tapping. */
    status?: string;
    onActivate: () => void;
    /** When set, render a paired secondary button to the right
     *  that clears an active override without leaving the menu. */
    reset?: { label: string; onActivate: () => void };
    /** When true, render the row as non-interactive (no Enter
     *  activation, skipped by D-pad navigation, halved opacity). The
     *  status sub-text is what the parent should read instead. Used
     *  for "No modes configured" today; designed as a generic flag
     *  so future feature rows can surface the same dead-end-avoiding
     *  pattern. */
    disabled?: boolean;
};

type MenuViewProps = {
    ctx: StageCtx;
    token: string;
    itemId: string;
    itemName: string;
    itemType: string;
    editTargetId: string;
    editTargetName: string;
    isMarkable: boolean;
    isSeason: boolean;
    played?: boolean;
    onMarkPlayed: (played: boolean) => void;
    onQR: (url: string) => void;
};

export function MenuView({
    ctx,
    token,
    itemName,
    itemType,
    editTargetName,
    isMarkable,
    isSeason,
    played,
    onMarkPlayed,
}: MenuViewProps) {
    const time = useTimeStatus();
    const effectiveTime = useEffectiveTimeStatus();
    const viewing = useViewingState();
    const mode = useActiveMode();
    // Body breaks status: poll at the slower (non-playing) cadence
    // here - the kid isn't on /play while the override modal is
    // open, so the 60s tick is plenty for a status sub-text.
    const bodyBreakStatus = useBodyBreakStatus(false);

    // Per-content time-limit row is the only thing we still gate on
    // server status: an item-scoped budget makes no sense when no
    // daily limit exists at all. Global feature-level rows always
    // render so the parent can introduce a one-off cutoff (e.g.
    // "TV off at 8pm tonight") even when nothing is configured
    // globally.
    const hasContentTimeLimit = !!time?.enabled;
    const activeMode = mode?.mode;

    // Local override readers - drive the secondary "Reset NN%" /
    // "Reset" buttons paired next to each system row when the
    // parent already has a runtime override active. Subscribed via
    // useParentOverride so writes from the sub-views ripple back
    // into the menu when the kid pops to the root.
    const dimOv = useParentOverride(() => overrides.getDim());
    const warmOv = useParentOverride(() => overrides.getWarm());
    const modeOv = useParentOverride(() => overrides.getMode());
    const bodyBreaksOv = useParentOverride(() => overrides.getBodyBreaks());
    const autoOffOv = useParentOverride(() => overrides.getAutoOff());
    const globalTimeOv = useParentOverride(() => overrides.getGlobalTime());

    // Per-feature status summaries. Each returns the muted sub-text
    // line + booleans that pick the action verb ("Temporarily turn
    // on …" vs the existing configured-feature copy).
    const modeSummary = summarizeMode(mode, modeOv);
    const dimSummary = summarizeViewingPercent(viewing?.dimPercent, dimOv);
    const warmSummary = summarizeViewingPercent(
        viewing?.warmTintPercent,
        warmOv,
    );
    const globalTimeSummary = summarizeGlobalTime(
        time,
        effectiveTime,
        globalTimeOv,
    );
    const bodyBreaksSummary = summarizeBodyBreaks(
        bodyBreakStatus,
        bodyBreaksOv,
    );
    const autoOffSummary = summarizeAutoOff(
        viewing,
        autoOffOv,
        viewing?.sleepTimerAt,
    );

    // Manage-section rows: persistent edits to the focused item
    // (tags, hide, mark, per-content time-limit). Mark watched and
    // mark unwatched collapse to a single row - whichever inverts
    // the current state. For Season we don't have a single
    // boolean (the aggregate is many-or-some-or-none) so we keep
    // both rows when isSeason.
    const manage: MenuRow[] = [
        {
            key: "tags",
            icon: <IconTag />,
            label: `Edit tags (${editTargetName})`,
            onActivate: () => ctx.push({ kind: "tags", token }),
        },
        {
            key: "hide",
            icon: <IconHide />,
            label: `Hide ${editTargetName}`,
            onActivate: () => ctx.push({ kind: "hideConfirm", token }),
        },
    ];
    if (hasContentTimeLimit) {
        manage.push({
            key: "contentTime",
            icon: <IconClock />,
            label: `Adjust time limit (${editTargetName})`,
            onActivate: () => ctx.push({ kind: "contentTime", token }),
        });
    }
    if (isMarkable) {
        if (isSeason || played === undefined) {
            manage.push({
                key: "markPlayed",
                icon: <IconCheck />,
                label: isSeason ? "Mark season watched" : "Mark watched",
                onActivate: () => onMarkPlayed(true),
            });
            manage.push({
                key: "markUnplayed",
                icon: <IconUncheck />,
                label: isSeason ? "Mark season unwatched" : "Mark unwatched",
                onActivate: () => onMarkPlayed(false),
            });
        } else if (played) {
            manage.push({
                key: "markUnplayed",
                icon: <IconUncheck />,
                label: "Mark unwatched",
                onActivate: () => onMarkPlayed(false),
            });
        } else {
            manage.push({
                key: "markPlayed",
                icon: <IconCheck />,
                label: "Mark watched",
                onActivate: () => onMarkPlayed(true),
            });
        }
    }

    // System-section rows. Each row is either a single button or a
    // [primary, reset] pair when an override is currently active.
    // The pair is rendered horizontally; pressing reset clears the
    // override in place without leaving the menu.
    const system: MenuRow[] = [];

    // Action labels follow the same rule per feature: when the
    // feature is currently producing no effect (off server-side AND
    // no override active), copy switches to "Temporarily turn on …"
    // so the parent reads it as introducing a fresh effect rather
    // than adjusting one. Otherwise we keep the existing
    // "Override …" / "Adjust …" verbs.
    const modeLabel = modeSummary.disabled
        ? "Turn on a mode"
        : !modeSummary.isOn && !modeSummary.isOverride
          ? "Temporarily turn on a mode"
          : activeMode
            ? `Change mode (currently ${activeMode.name})`
            : "Turn on a mode";
    system.push({
        key: "mode",
        icon: <IconMode />,
        label: modeLabel,
        status: modeSummary.status,
        onActivate: () => ctx.push({ kind: "modeAction", token }),
        // Mode override is "active" when a local override exists.
        // The configured/scheduled mode is server-driven; clearing
        // a local mode override drops back to server state.
        // Reset is suppressed when disabled (no modes configured) so
        // the row stays a single non-interactive line.
        reset:
            modeOv && !modeSummary.disabled
                ? {
                      label:
                          modeOv.action === "disable"
                              ? "Restore mode"
                              : "Reset override",
                      onActivate: () => overrides.clearMode(),
                  }
                : undefined,
        disabled: modeSummary.disabled,
    });

    const dimLabel =
        !dimSummary.isOn && !dimSummary.isOverride
            ? "Temporarily set dimming"
            : "Override dimming";
    system.push({
        key: "dim",
        icon: <IconDim />,
        label: dimLabel,
        status: dimSummary.status,
        onActivate: () => ctx.push({ kind: "dimSetup", token }),
        reset: dimOv
            ? {
                  label: `Reset ${dimOv.percent}% override`,
                  onActivate: () => overrides.clearDim(),
              }
            : undefined,
    });

    const warmLabel =
        !warmSummary.isOn && !warmSummary.isOverride
            ? "Temporarily set warming"
            : "Override warming";
    system.push({
        key: "warm",
        icon: <IconWarm />,
        label: warmLabel,
        status: warmSummary.status,
        onActivate: () => ctx.push({ kind: "warmSetup", token }),
        reset: warmOv
            ? {
                  label: `Reset ${warmOv.percent}% override`,
                  onActivate: () => overrides.clearWarm(),
              }
            : undefined,
    });

    // Global time, body breaks, and auto-off rows always render -
    // even when the server has the feature globally disabled - so
    // the parent can layer a one-off override on top (e.g. "TV
    // off at 8pm tonight" with no scheduled auto-off configured).
    // The server-merge layer in kidStatus.ts produces an effective
    // "enabled" status when an override-only configuration is
    // present.
    const timeLabel =
        !globalTimeSummary.isOn && !globalTimeSummary.isOverride
            ? "Temporarily turn on daily time limit"
            : "Adjust daily time limit";
    system.push({
        key: "globalTime",
        icon: <IconClock />,
        label: timeLabel,
        status: globalTimeSummary.status,
        onActivate: () => ctx.push({ kind: "globalTime", token }),
        reset: globalTimeOv
            ? {
                  label: "Reset time override",
                  onActivate: () => overrides.clearGlobalTime(),
              }
            : undefined,
    });

    const bodyBreaksLabel =
        !bodyBreaksSummary.isOn && !bodyBreaksSummary.isOverride
            ? "Temporarily turn on body breaks"
            : "Pause body breaks";
    system.push({
        key: "bodyBreaks",
        icon: <IconBreak />,
        label: bodyBreaksLabel,
        status: bodyBreaksSummary.status,
        onActivate: () => ctx.push({ kind: "bodyBreaks", token }),
        reset: bodyBreaksOv
            ? {
                  label: "Reset breaks override",
                  onActivate: () => overrides.clearBodyBreaks(),
              }
            : undefined,
    });

    // When the server has no auto-off configured, "Enable auto-off"
    // sends the parent straight to the one-time absolute-time
    // picker - the relative-shift picker is meaningless without a
    // baseline and was the source of the "+1065233659 min" bug
    // (delta math computed against an epoch-zero baseline). When
    // the server has a configured time, push the stage menu so the
    // parent can choose between "Disable until tomorrow" and
    // "Shift the time".
    const autoOffConfigured = !!viewing?.sleepTimerAt;
    const autoOffLabel =
        !autoOffSummary.isOn && !autoOffSummary.isOverride
            ? "Temporarily turn on auto-off"
            : "Adjust auto-off";
    system.push({
        key: "autoOff",
        icon: <IconAutoOff />,
        label: autoOffLabel,
        status: autoOffSummary.status,
        onActivate: () =>
            ctx.push(
                autoOffConfigured
                    ? { kind: "autoOff", token }
                    : { kind: "autoOffOneTime", token },
            ),
        reset: autoOffOv
            ? {
                  label: "Reset auto-off override",
                  onActivate: () => overrides.clearAutoOff(),
              }
            : undefined,
    });

    // BackLink "Done" sits at the bottom of the focus order: ArrowDown
    // from the last MenuSections row lands here; ArrowUp from here
    // bounces back into the section grid. Without this wiring the
    // link looks selectable but is unreachable via D-pad - exactly
    // the "phantom affordance" parent feedback we're fixing.
    const backRef = useRef<HTMLButtonElement | null>(null);
    const sectionsRef = useRef<HTMLDivElement | null>(null);
    return (
        <ModalShell title="Adult menu" subtitle={`${itemType}: ${itemName}`}>
            <div ref={sectionsRef}>
                <MenuSections
                    sections={[
                        { heading: `Manage ${editTargetName}`, rows: manage },
                        { heading: "System", rows: system },
                    ]}
                    onExitDown={() => backRef.current?.focus()}
                />
            </div>
            <BackLink
                onActivate={ctx.close}
                label="Done"
                buttonRef={backRef}
                onKeyDown={(e) => {
                    if (e.key === "ArrowUp") {
                        e.preventDefault();
                        // Focus the last enabled primary button in the
                        // sections grid - querying the live DOM keeps
                        // this resilient to disabled rows / re-renders.
                        const buttons =
                            sectionsRef.current?.querySelectorAll<HTMLButtonElement>(
                                "button.override-row-primary",
                            );
                        if (buttons && buttons.length > 0) {
                            buttons[buttons.length - 1].focus();
                        }
                    }
                }}
            />
        </ModalShell>
    );
}

// MenuSections: renders multiple labeled sections of MenuRows in
// a single navigable group. Up/Down walks the flat row list
// (skipping headings); Left/Right toggles between a row's
// primary button and its paired reset. The first row's primary
// button autofocuses on mount unless `noAutoFocus` is set.
//
// Implemented as one component (instead of one Section per
// heading) so cross-section Up/Down navigation is trivial - the
// refs grid is owned in one place and there's no parent-level
// focus relay needed.
function MenuSections({
    sections,
    noAutoFocus,
    onExitDown,
}: {
    sections: { heading: string; rows: MenuRow[] }[];
    noAutoFocus?: boolean;
    onExitDown?: () => void;
}) {
    const visible = sections.filter((s) => s.rows.length > 0);
    // refs[rowIdx] = [primaryRef, resetRef|undefined]
    const flatRows = visible.flatMap((s) => s.rows);
    const refs = useRef<(HTMLButtonElement | null)[][]>([]);
    refs.current = flatRows.map((_, i) => refs.current[i] ?? [null, null]);

    useEffect(() => {
        if (noAutoFocus) return;
        // First non-disabled row gets initial focus. Disabled rows
        // render as static <div>s so refs.current[i][0] is null.
        for (let i = 0; i < flatRows.length; i++) {
            if (flatRows[i].disabled) continue;
            const btn = refs.current[i]?.[0];
            if (btn) {
                btn.focus();
                return;
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    function moveVertical(rowIdx: number, dir: 1 | -1) {
        // Always land on the primary column when crossing rows;
        // primary is the wider hit and exists on every row. Skip
        // rows that have no focusable button (disabled rows render
        // as a static <div> and don't enter the refs grid).
        let next = rowIdx + dir;
        while (next >= 0 && next < flatRows.length) {
            const btn = refs.current[next]?.[0];
            if (btn && !flatRows[next].disabled) {
                btn.focus();
                return true;
            }
            next += dir;
        }
        return false;
    }

    function onKeyDown(
        rowIdx: number,
        col: 0 | 1,
        e: React.KeyboardEvent,
    ) {
        if (e.key === "ArrowDown") {
            e.preventDefault();
            const moved = moveVertical(rowIdx, 1);
            if (!moved && onExitDown) onExitDown();
            return;
        }
        if (e.key === "ArrowUp") {
            e.preventDefault();
            moveVertical(rowIdx, -1);
            return;
        }
        if (e.key === "ArrowRight") {
            const reset = refs.current[rowIdx]?.[1];
            if (col === 0 && reset) {
                e.preventDefault();
                reset.focus();
            }
            return;
        }
        if (e.key === "ArrowLeft") {
            const primary = refs.current[rowIdx]?.[0];
            if (col === 1 && primary) {
                e.preventDefault();
                primary.focus();
            }
            return;
        }
    }

    let rowIdx = 0;
    return (
        <>
            {visible.map((section) => (
                <div className="override-section" key={section.heading}>
                    <h3 className="override-section-heading">
                        {section.heading}
                    </h3>
                    <div className="override-section-rows">
                        {section.rows.map((row) => {
                            const i = rowIdx++;
                            // Disabled row: render as a static block so
                            // it sits in the visual flow but is skipped
                            // by D-pad navigation, takes no Enter, and
                            // visually reads as inert (halved opacity,
                            // no focus ring). The status sub-text is
                            // what carries the meaning ("No modes
                            // configured").
                            if (row.disabled) {
                                return (
                                    <div
                                        className="override-row"
                                        key={row.key}
                                    >
                                        <div
                                            className={`override-action override-row-primary override-row-disabled${row.status ? " has-status" : ""}`}
                                            aria-disabled="true"
                                        >
                                            <span
                                                className="override-action-icon"
                                                aria-hidden
                                            >
                                                {row.icon}
                                            </span>
                                            <span className="override-action-text">
                                                <span className="override-action-label">
                                                    {row.label}
                                                </span>
                                                {row.status !== undefined && (
                                                    <span className="override-menu-status">
                                                        {row.status}
                                                    </span>
                                                )}
                                            </span>
                                        </div>
                                    </div>
                                );
                            }
                            return (
                                <div className="override-row" key={row.key}>
                                    <button
                                        ref={(el) => {
                                            refs.current[i] = refs.current[i] ?? [
                                                null,
                                                null,
                                            ];
                                            refs.current[i][0] = el;
                                        }}
                                        type="button"
                                        className={`override-action override-row-primary${row.reset ? " has-reset" : ""}${row.status ? " has-status" : ""}`}
                                        onClick={row.onActivate}
                                        onKeyDown={(e) => onKeyDown(i, 0, e)}
                                    >
                                        <span
                                            className="override-action-icon"
                                            aria-hidden
                                        >
                                            {row.icon}
                                        </span>
                                        <span className="override-action-text">
                                            <span className="override-action-label">
                                                {row.label}
                                            </span>
                                            {row.status !== undefined && (
                                                <span className="override-menu-status">
                                                    {row.status}
                                                </span>
                                            )}
                                        </span>
                                    </button>
                                    {row.reset && (
                                        <button
                                            ref={(el) => {
                                                refs.current[i] = refs
                                                    .current[i] ?? [null, null];
                                                refs.current[i][1] = el;
                                            }}
                                            type="button"
                                            className="override-action override-row-reset"
                                            onClick={() => {
                                                row.reset?.onActivate();
                                                // After the override clears,
                                                // the reset button unmounts +
                                                // DOM focus falls back to
                                                // body. rAF lets React commit
                                                // the override-cleared
                                                // re-render first, then we
                                                // park focus on the row's
                                                // primary button so the kid
                                                // doesn't lose their place.
                                                requestAnimationFrame(() => {
                                                    refs.current[i]?.[0]?.focus();
                                                });
                                            }}
                                            onKeyDown={(e) =>
                                                onKeyDown(i, 1, e)
                                            }
                                        >
                                            {row.reset.label}
                                        </button>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            ))}
        </>
    );
}
