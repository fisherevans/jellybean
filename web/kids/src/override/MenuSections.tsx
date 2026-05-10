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
    useActiveMode,
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
    onActivate: () => void;
    /** When set, render a paired secondary button to the right
     *  that clears an active override without leaving the menu. */
    reset?: { label: string; onActivate: () => void };
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
    const viewing = useViewingState();
    const mode = useActiveMode();

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

    system.push({
        key: "mode",
        icon: <IconMode />,
        label: activeMode
            ? `Change mode (currently ${activeMode.name})`
            : "Turn on a mode",
        onActivate: () => ctx.push({ kind: "modeAction", token }),
        // Mode override is "active" when a local override exists.
        // The configured/scheduled mode is server-driven; clearing
        // a local mode override drops back to server state.
        reset: modeOv
            ? {
                  label:
                      modeOv.action === "disable"
                          ? "Restore mode"
                          : "Reset override",
                  onActivate: () => overrides.clearMode(),
              }
            : undefined,
    });

    system.push({
        key: "dim",
        icon: <IconDim />,
        label: "Override dimming",
        onActivate: () => ctx.push({ kind: "dimSetup", token }),
        reset: dimOv
            ? {
                  label: `Reset ${dimOv.percent}% override`,
                  onActivate: () => overrides.clearDim(),
              }
            : undefined,
    });

    system.push({
        key: "warm",
        icon: <IconWarm />,
        label: "Override warming",
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
    const timeLabel = time?.enabled
        ? `Adjust daily time (${time.minutesRemaining}m left)`
        : "Adjust daily time";
    system.push({
        key: "globalTime",
        icon: <IconClock />,
        label: timeLabel,
        onActivate: () => ctx.push({ kind: "globalTime", token }),
        reset: globalTimeOv
            ? {
                  label: "Reset time override",
                  onActivate: () => overrides.clearGlobalTime(),
              }
            : undefined,
    });

    system.push({
        key: "bodyBreaks",
        icon: <IconBreak />,
        label: "Pause body breaks",
        onActivate: () => ctx.push({ kind: "bodyBreaks", token }),
        reset: bodyBreaksOv
            ? {
                  label: "Reset breaks override",
                  onActivate: () => overrides.clearBodyBreaks(),
              }
            : undefined,
    });

    system.push({
        key: "autoOff",
        icon: <IconAutoOff />,
        label: viewing?.sleepTimerAt
            ? "Override auto-off"
            : "Set one-time auto-off",
        onActivate: () => ctx.push({ kind: "autoOff", token }),
        reset: autoOffOv
            ? {
                  label: "Reset auto-off override",
                  onActivate: () => overrides.clearAutoOff(),
              }
            : undefined,
    });

    return (
        <ModalShell title="Adult menu" subtitle={`${itemType}: ${itemName}`}>
            <MenuSections
                sections={[
                    { heading: `Manage ${editTargetName}`, rows: manage },
                    { heading: "System", rows: system },
                ]}
            />
            <BackLink onActivate={ctx.close} label="Done" />
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
        refs.current[0]?.[0]?.focus();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    function moveVertical(rowIdx: number, dir: 1 | -1) {
        // Always land on the primary column when crossing rows;
        // primary is the wider hit and exists on every row.
        let next = rowIdx + dir;
        while (next >= 0 && next < flatRows.length) {
            const btn = refs.current[next]?.[0];
            if (btn) {
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
                                        className={`override-action override-row-primary${row.reset ? " has-reset" : ""}`}
                                        onClick={row.onActivate}
                                        onKeyDown={(e) => onKeyDown(i, 0, e)}
                                    >
                                        <span
                                            className="override-action-icon"
                                            aria-hidden
                                        >
                                            {row.icon}
                                        </span>
                                        <span className="override-action-label">
                                            {row.label}
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
