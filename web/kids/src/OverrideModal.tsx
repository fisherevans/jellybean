import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";
import {
    ArrowLeft,
    Check,
    CheckCircle,
    Circle,
    Clock,
    Coffee,
    EyeSlash,
    Moon,
    Sparkle,
    SunDim,
    Tag as TagIcon,
} from "@phosphor-icons/react";
import { authHeaders } from "./auth";
import KidModalShell from "./KidModalShell";
import { useProgressiveBack } from "./useProgressiveBack";
import * as overrides from "./parentOverrides";
import {
    expiresFromMinutes,
    nextLocalMidnight,
    useParentOverride,
} from "./parentOverrides";
import {
    useActiveMode,
    useBodyBreakStatus,
    useTimeStatus,
    useViewingState,
} from "./kidStatus";

// Icon glyphs used in the section rows. weight="fill" matches the
// rest of the kid app's Phosphor usage; the modal's grayscale
// palette dims them without further styling.
const ICON_SIZE = 18;
const IconTag = () => <TagIcon size={ICON_SIZE} weight="fill" />;
const IconHide = () => <EyeSlash size={ICON_SIZE} weight="fill" />;
const IconCheck = () => <CheckCircle size={ICON_SIZE} weight="fill" />;
const IconUncheck = () => <Circle size={ICON_SIZE} weight="regular" />;
const IconClock = () => <Clock size={ICON_SIZE} weight="fill" />;
const IconMode = () => <Sparkle size={ICON_SIZE} weight="fill" />;
const IconDim = () => <SunDim size={ICON_SIZE} weight="fill" />;
const IconWarm = () => <Sparkle size={ICON_SIZE} weight="fill" />;
const IconBreak = () => <Coffee size={ICON_SIZE} weight="fill" />;
const IconAutoOff = () => <Moon size={ICON_SIZE} weight="fill" />;
const IconArrowLeft = () => <ArrowLeft size={16} weight="bold" />;
const IconConfirmCheck = () => <Check size={16} weight="bold" />;

// Adult override modal (M9 v2). PIN-gated parent menu for the kid
// TV. Two halves to the post-PIN menu:
//
//   1. "This <type>" - actions that mutate persistent state for
//      the focused item (edit tags, hide, mark watched/unwatched,
//      adjust per-content time limit). Episodes / seasons scope
//      tags + hide to the parent series.
//
//   2. "Right now" - device-local runtime overrides (mode, dim,
//      warm, global time, body breaks, auto-off). These never
//      hit the server; they live in localStorage via
//      ./parentOverrides and the kid client's effective-status
//      hooks merge them on top of the server-reported state.
//
// Stage stack: each sub-view is pushed onto a stack so Back pops
// to the parent menu instead of closing the modal. Root Back
// (stack of length 1) closes.
//
// Adult styling: the modal root carries `kids-override-adult` so
// CSS swaps the kid app's pill/bubble palette for a darker
// utility-style look (see styles.css).

type Tag = { id: number; name: string };

type Props = {
    itemId: string;
    itemName: string;
    /** "Movie" | "Series" | "Episode" | "Season" | string. Drives
     *  conditional menu items (mark watched/unwatched on
     *  movie/episode/season; hide+tags scope to parent series for
     *  episodes/seasons). */
    itemType: string;
    /** When the focused item is an Episode or Season, the parent
     *  series id. Used to scope edit-tags / hide / per-content
     *  time-limit actions to the show rather than the single
     *  episode. Optional because Browse / Library tiles are
     *  Movies and Series in practice; episode long-press becomes
     *  reachable later. */
    seriesId?: string;
    seriesName?: string;
    /** True when the focused item is already watched (PlayedPercentage
     *  >= 90 OR UserData.Played). Drives mark-watched/unwatched: we
     *  show only the inverse action so the menu isn't padded with the
     *  "do nothing" branch. Optional: when omitted (e.g. Season,
     *  where the played state is aggregate) we show both. */
    played?: boolean;
    onClose: () => void;
};

type Stage =
    | { kind: "pin" }
    | { kind: "menu"; token: string }
    | { kind: "tags"; token: string }
    | { kind: "hideConfirm"; token: string }
    | { kind: "contentTime"; token: string }
    | { kind: "globalTime"; token: string }
    | { kind: "modeAction"; token: string }
    | { kind: "modePicker"; token: string }
    | {
          kind: "modeDuration";
          token: string;
          intent: "set" | "disable";
          modeId?: number;
          modeName?: string;
      }
    | { kind: "dimSetup"; token: string }
    | { kind: "warmSetup"; token: string }
    | { kind: "bodyBreaks"; token: string }
    | { kind: "autoOff"; token: string }
    | { kind: "autoOffShift"; token: string }
    | { kind: "qr"; token: string; url: string }
    | { kind: "error"; message: string }
    | { kind: "done"; message: string };

// ---- duration option sets shared across sub-views ---------------

type DurationOpt = {
    id: string;
    label: string;
    /** Returns ISO timestamp the override should expire at. Some
     *  options ("rest of day", "until tomorrow") need the current
     *  date to compute, so the resolver runs on click. */
    resolve: () => string;
};

const DUR_LONG: DurationOpt[] = [
    { id: "30m", label: "30 minutes", resolve: () => expiresFromMinutes(30) },
    { id: "1h", label: "1 hour", resolve: () => expiresFromMinutes(60) },
    { id: "2h", label: "2 hours", resolve: () => expiresFromMinutes(120) },
    { id: "4h", label: "4 hours", resolve: () => expiresFromMinutes(240) },
    { id: "rod", label: "Rest of day", resolve: () => nextLocalMidnight() },
];

// ADJUST_OPTS pairs minutes-to-add OR a "disable until midnight"
// flag with each row. The picker uses minutes when set, else falls
// back to the disabledUntilMidnight branch.
type AdjustOpt = {
    id: string;
    label: string;
    addedMinutes?: number;
    /** Reset = clear any active override so the kid sees server-
     *  reported state. */
    clear?: true;
    untilMidnight?: true;
};

function makeAdjustOpts(noLimitLabel: string): AdjustOpt[] {
    return [
        { id: "+5m", label: "+5 minutes", addedMinutes: 5 },
        { id: "+15m", label: "+15 minutes", addedMinutes: 15 },
        { id: "+30m", label: "+30 minutes", addedMinutes: 30 },
        { id: "+1h", label: "+1 hour", addedMinutes: 60 },
        { id: "+2h", label: "+2 hours", addedMinutes: 120 },
        { id: "reset", label: "Reset (clear override)", clear: true },
        { id: "until-tomorrow", label: noLimitLabel, untilMidnight: true },
    ];
}

const ADJUST_TIME = makeAdjustOpts("No limit until tomorrow");
const ADJUST_BREAKS = makeAdjustOpts("No body breaks until tomorrow");

const SHIFT_STEP_MIN = 15;

// ---- session reuse helpers --------------------------------------

const SESSION_KEY = "jellybean.kids.overrides.session";

type StoredSession = { token: string; expiresAt: string };

function readStoredSession(): StoredSession | null {
    try {
        const raw = sessionStorage.getItem(SESSION_KEY);
        if (!raw) return null;
        const v = JSON.parse(raw) as StoredSession;
        const t = Date.parse(v.expiresAt);
        // Conservative: drop the session 5s before the server's
        // declared expiry so an in-flight request after a stale
        // local pointer doesn't 401 mid-action.
        if (!Number.isFinite(t) || t - 5_000 <= Date.now()) {
            sessionStorage.removeItem(SESSION_KEY);
            return null;
        }
        return v;
    } catch {
        return null;
    }
}

function writeStoredSession(v: StoredSession): void {
    try {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(v));
    } catch {
        /* quota - ignore */
    }
}

// ---- main component ---------------------------------------------

export default function OverrideModal({
    itemId,
    itemName,
    itemType,
    seriesId,
    seriesName,
    played,
    onClose,
}: Props) {
    // For tags / hide / content-time, scope to the parent series
    // when the focused item is an episode or season.
    const editTargetId =
        (itemType === "Episode" || itemType === "Season") && seriesId
            ? seriesId
            : itemId;
    const editTargetName =
        (itemType === "Episode" || itemType === "Season") && seriesName
            ? seriesName
            : itemName;
    const isMarkable =
        itemType === "Movie" ||
        itemType === "Episode" ||
        itemType === "Season";
    const isSeason = itemType === "Season";

    // Forward admin-preview params (?profileId=, ?kidId=) on every
    // override fetch so the server can act as the right kid when
    // no kid bearer is present.
    const [searchParams] = useSearchParams();
    const previewQuery = useMemo(() => {
        const out = new URLSearchParams();
        const pid = searchParams.get("profileId");
        const kid = searchParams.get("kidId");
        if (pid) out.set("profileId", pid);
        if (kid) out.set("kidId", kid);
        const s = out.toString();
        return s ? `?${s}` : "";
    }, [searchParams]);
    const previewQueryRef = useRef(previewQuery);
    previewQueryRef.current = previewQuery;

    // Stage stack. Push on submenu-enter, pop on Back. PIN is
    // always at the bottom; once the kid auths it gets replaced
    // with a "menu" stack.
    //
    // Session reuse: the server's override session has a 60s
    // sliding TTL. On mount, if a previously-minted session is
    // still in window, skip the PIN entry. The session token +
    // expiresAt are persisted in sessionStorage so that closing
    // and reopening the modal within 60s keeps the kid auth'd.
    // sessionStorage scope (per tab/app, wiped on app close) is
    // the right fit - signing out wipes everything (auth.ts
    // iterates `jellybean.kids.` prefix in clearSession).
    const [stack, setStack] = useState<Stage[]>(() => {
        const stored = readStoredSession();
        if (stored) return [{ kind: "menu", token: stored.token }];
        return [{ kind: "pin" }];
    });
    const stage = stack[stack.length - 1];
    const push = (s: Stage) => setStack((prev) => [...prev, s]);
    const pop = () => setStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
    const replaceTop = (s: Stage) =>
        setStack((prev) => [...prev.slice(0, -1), s]);

    // PIN entry state. The PIN stage's keyboard listener +
    // armed/keyup gate + portal/Escape/repeat-Enter swallow live in
    // PinStage (below) which wraps KidModalShell. Other stages keep
    // using the file-local ModalShell + their own listeners.
    const [pinDigits, setPinDigits] = useState<string>("");
    const [pinBusy, setPinBusy] = useState(false);
    const [pinError, setPinError] = useState<string | null>(null);
    const [pinFlashError, setPinFlashError] = useState(false);

    const closeRef = useRef(onClose);
    closeRef.current = onClose;

    // Bridge Back: pop the stack; if at root, close the modal.
    useProgressiveBack(() => {
        if (stack.length > 1) {
            setStack((prev) => prev.slice(0, -1));
            return true;
        }
        closeRef.current();
        return true;
    });

    // 30s sliding TTL: while a token is in scope, refresh so the
    // 60s server session stays alive.
    const tokenForRefresh =
        stage.kind === "pin" || stage.kind === "error" || stage.kind === "done"
            ? ""
            : (stage as { token?: string }).token ?? "";
    useEffect(() => {
        if (!tokenForRefresh) return;
        const id = setInterval(() => {
            void fetch(
                `/api/kids/override/refresh${previewQueryRef.current}`,
                {
                    method: "POST",
                    credentials: "same-origin",
                    headers: {
                        ...authHeaders(),
                        "X-Override-Token": tokenForRefresh,
                    },
                },
            );
        }, 30_000);
        return () => clearInterval(id);
    }, [tokenForRefresh]);

    // Don't end the session on unmount - we want the kid (parent)
    // to be able to close + reopen within 60s without retyping the
    // PIN. The server's session expires naturally if no /refresh
    // ping arrives; clearStoredSession is called from the
    // verify-pin path on a wrong PIN to drop a stale local
    // pointer, and on sign-out via auth.ts's clearSession (which
    // iterates the jellybean.kids. prefix).

    async function submitPIN(candidate: string) {
        if (candidate.length < 4) {
            setPinError("Enter the full 4-step pattern.");
            return;
        }
        setPinBusy(true);
        setPinError(null);
        try {
            const res = await fetch(
                `/api/kids/override/verify-pin${previewQueryRef.current}`,
                {
                    method: "POST",
                    credentials: "same-origin",
                    headers: {
                        ...authHeaders(),
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({ pin: candidate }),
                },
            );
            if (res.status === 423) {
                const retry = res.headers.get("Retry-After") ?? "60";
                setPinError(`Locked out. Try again in ${retry}s.`);
                setPinDigits("");
                return;
            }
            if (res.status === 412) {
                replaceTop({
                    kind: "error",
                    message:
                        "No pattern configured. Ask a grown-up to set one in /admin/settings.",
                });
                return;
            }
            if (!res.ok) {
                setPinDigits("");
                setPinFlashError(true);
                window.setTimeout(() => setPinFlashError(false), 600);
                return;
            }
            const body = (await res.json()) as {
                token: string;
                expiresAt?: number;
            };
            // Persist for the 60s reuse window. If the server
            // didn't send expiresAt, default to 60s ahead.
            const ttlSecs = 60;
            const expiresAt = body.expiresAt
                ? new Date(body.expiresAt * 1000).toISOString()
                : new Date(Date.now() + ttlSecs * 1000).toISOString();
            writeStoredSession({ token: body.token, expiresAt });
            replaceTop({ kind: "menu", token: body.token });
            setPinDigits("");
        } catch (err) {
            setPinError(err instanceof Error ? err.message : "request failed");
            setPinDigits("");
        } finally {
            setPinBusy(false);
        }
    }

    // ---- render based on top-of-stack stage ---------------------

    if (stage.kind === "pin") {
        return (
            <PinStage
                itemName={itemName}
                pinDigits={pinDigits}
                pinBusy={pinBusy}
                pinError={pinError}
                pinFlashError={pinFlashError}
                onClose={() => closeRef.current()}
                onAppendDigit={(ch) => {
                    if (pinBusy) return;
                    setPinDigits((d) => {
                        if (d.length >= 4) return d;
                        const next = d + ch;
                        if (next.length === 4) {
                            // Defer to next tick so the dot fills
                            // before the request fires.
                            setTimeout(() => void submitPIN(next), 0);
                        }
                        return next;
                    });
                }}
                onBackspace={() => {
                    if (pinBusy) return;
                    setPinDigits((d) => d.slice(0, -1));
                }}
                onSubmit={() => {
                    if (pinBusy) return;
                    void submitPIN(pinDigits);
                }}
            />
        );
    }

    if (stage.kind === "error") {
        return (
            <ModalShell title="Override unavailable">
                <p>{stage.message}</p>
                <BackLink
                    autoFocus
                    onActivate={() => closeRef.current()}
                    label="Close"
                    icon={null}
                />
            </ModalShell>
        );
    }

    if (stage.kind === "done") {
        return (
            <ModalShell title="Done">
                <p>{stage.message}</p>
                <BackLink
                    autoFocus
                    onActivate={() => closeRef.current()}
                    label="Close"
                    icon={<IconConfirmCheck />}
                />
            </ModalShell>
        );
    }

    if (stage.kind === "qr") {
        return (
            <ModalShell title="Open on your phone">
                <p className="muted">
                    Scan to manage "{editTargetName}" from a browser.
                </p>
                <div className="override-qr-wrap">
                    <img
                        src={`https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(stage.url)}`}
                        alt={`QR code linking to ${stage.url}`}
                        width={240}
                        height={240}
                    />
                </div>
                <code className="override-qr-url">{stage.url}</code>
                <BackLink autoFocus onActivate={pop} />
            </ModalShell>
        );
    }

    if (stage.kind === "tags") {
        return (
            <TagsView
                itemId={editTargetId}
                itemName={editTargetName}
                token={stage.token}
                previewQuery={previewQuery}
                onBack={pop}
                onClose={() => closeRef.current()}
            />
        );
    }

    if (stage.kind === "hideConfirm") {
        return (
            <HideConfirmView
                itemId={editTargetId}
                itemName={editTargetName}
                itemType={itemType}
                token={stage.token}
                previewQuery={previewQuery}
                onCancel={pop}
                onDone={(msg) => replaceTop({ kind: "done", message: msg })}
            />
        );
    }

    if (stage.kind === "contentTime") {
        return (
            <ContentTimeView
                itemId={editTargetId}
                itemName={editTargetName}
                onBack={pop}
                onDone={(msg) => replaceTop({ kind: "done", message: msg })}
            />
        );
    }

    if (stage.kind === "globalTime") {
        return (
            <GlobalTimeView
                onBack={pop}
                onDone={(msg) => replaceTop({ kind: "done", message: msg })}
            />
        );
    }

    if (stage.kind === "modeAction") {
        return (
            <ModeActionView
                onBack={pop}
                onDisable={(modeName) =>
                    push({
                        kind: "modeDuration",
                        token: stage.token,
                        intent: "disable",
                        modeName,
                    })
                }
                onTurnOn={() => push({ kind: "modePicker", token: stage.token })}
            />
        );
    }

    if (stage.kind === "modePicker") {
        return (
            <ModePickerView
                onBack={pop}
                onPick={(modeId, modeName) =>
                    push({
                        kind: "modeDuration",
                        token: stage.token,
                        intent: "set",
                        modeId,
                        modeName,
                    })
                }
            />
        );
    }

    if (stage.kind === "modeDuration") {
        return (
            <DurationPickerView
                title={
                    stage.intent === "disable"
                        ? `Disable ${stage.modeName ?? "mode"} for…`
                        : `Turn on ${stage.modeName ?? "mode"} for…`
                }
                options={DUR_LONG}
                onBack={pop}
                onPick={(opt) => {
                    // DUR_LONG is DurationOpt[]; the generic
                    // picker types its callback as the union.
                    const expiresAt = (opt as DurationOpt).resolve();
                    if (stage.intent === "disable") {
                        overrides.setMode({ action: "disable", expiresAt });
                        replaceTop({
                            kind: "done",
                            message: `Mode disabled until ${formatExpiresShort(expiresAt)}.`,
                        });
                    } else if (stage.modeId !== undefined) {
                        overrides.setMode({
                            action: "set",
                            modeId: stage.modeId,
                            expiresAt,
                        });
                        replaceTop({
                            kind: "done",
                            message: `${stage.modeName ?? "Mode"} on until ${formatExpiresShort(expiresAt)}.`,
                        });
                    }
                }}
            />
        );
    }

    if (stage.kind === "dimSetup") {
        return (
            <ViewingSetupView
                control="dim"
                onBack={pop}
                onDone={(msg) => replaceTop({ kind: "done", message: msg })}
            />
        );
    }

    if (stage.kind === "warmSetup") {
        return (
            <ViewingSetupView
                control="warm"
                onBack={pop}
                onDone={(msg) => replaceTop({ kind: "done", message: msg })}
            />
        );
    }

    if (stage.kind === "bodyBreaks") {
        return (
            <DurationPickerView
                title="Disable body breaks…"
                options={ADJUST_BREAKS}
                onBack={pop}
                onPick={(opt) => {
                    const adj = opt as AdjustOpt;
                    if (adj.clear) {
                        overrides.clearBodyBreaks();
                        replaceTop({
                            kind: "done",
                            message: "Body break override cleared.",
                        });
                        return;
                    }
                    let until: string;
                    if (adj.untilMidnight) {
                        until = nextLocalMidnight();
                    } else if (adj.addedMinutes) {
                        until = expiresFromMinutes(adj.addedMinutes);
                    } else {
                        return;
                    }
                    overrides.setBodyBreaks({ disabledUntil: until });
                    replaceTop({
                        kind: "done",
                        message: `Body breaks paused until ${formatExpiresShort(until)}.`,
                    });
                }}
            />
        );
    }

    if (stage.kind === "autoOff") {
        return (
            <AutoOffView
                onBack={pop}
                onDisableUntilTomorrow={() => {
                    overrides.setAutoOff({
                        disabledUntilMidnight: true,
                        expiresAt: nextLocalMidnight(),
                    });
                    replaceTop({
                        kind: "done",
                        message: "Auto-off skipped until tomorrow.",
                    });
                }}
                onShift={() => push({ kind: "autoOffShift", token: stage.token })}
            />
        );
    }

    if (stage.kind === "autoOffShift") {
        return (
            <AutoOffShiftView
                onBack={pop}
                onSave={(deltaMinutes) => {
                    overrides.setAutoOff({
                        shiftMinutes: deltaMinutes,
                        expiresAt: nextLocalMidnight(),
                    });
                    const sign = deltaMinutes >= 0 ? "+" : "";
                    replaceTop({
                        kind: "done",
                        message: `Auto-off shifted ${sign}${deltaMinutes} min for today.`,
                    });
                }}
            />
        );
    }

    // stage.kind === "menu"
    return (
        <MenuView
            itemId={itemId}
            itemName={itemName}
            itemType={itemType}
            editTargetId={editTargetId}
            editTargetName={editTargetName}
            isMarkable={isMarkable}
            isSeason={isSeason}
            played={played}
            token={stage.token}
            previewQuery={previewQuery}
            onClose={() => closeRef.current()}
            onTags={() => push({ kind: "tags", token: stage.token })}
            onHide={() => push({ kind: "hideConfirm", token: stage.token })}
            onContentTime={() =>
                push({ kind: "contentTime", token: stage.token })
            }
            onGlobalTime={() =>
                push({ kind: "globalTime", token: stage.token })
            }
            onMode={() => push({ kind: "modeAction", token: stage.token })}
            onDim={() => push({ kind: "dimSetup", token: stage.token })}
            onWarm={() => push({ kind: "warmSetup", token: stage.token })}
            onBodyBreaks={() =>
                push({ kind: "bodyBreaks", token: stage.token })
            }
            onAutoOff={() => push({ kind: "autoOff", token: stage.token })}
            onMarkPlayed={(played) => {
                void doMark(stage.token, previewQuery, itemId, itemType, played, replaceTop);
            }}
            onQR={(url) => push({ kind: "qr", token: stage.token, url })}
        />
    );
}

// formatExpiresShort renders a friendly "until 8:30 PM" string for
// the done view.
function formatExpiresShort(iso: string): string {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return "soon";
    return d.toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
    });
}

// doMark POSTs the existing /mark/{state} endpoint, branching to
// /mark-season/{state} when the focused item is a Season.
async function doMark(
    token: string,
    previewQuery: string,
    itemId: string,
    itemType: string,
    played: boolean,
    replaceTop: (s: Stage) => void,
) {
    const path =
        itemType === "Season"
            ? `/api/kids/override/items/${encodeURIComponent(itemId)}/mark-season/${played ? "played" : "unplayed"}`
            : `/api/kids/override/items/${encodeURIComponent(itemId)}/mark/${played ? "played" : "unplayed"}`;
    const res = await fetch(`${path}${previewQuery}`, {
        method: "POST",
        credentials: "same-origin",
        headers: {
            ...authHeaders(),
            "X-Override-Token": token,
        },
    });
    if (!res.ok) {
        replaceTop({
            kind: "error",
            message: `Couldn't update (${res.status}).`,
        });
        return;
    }
    replaceTop({
        kind: "done",
        message: played ? "Marked as watched." : "Marked as unwatched.",
    });
}

// ============================================================
// Sub-views
// ============================================================

// MenuView: post-PIN main menu. Conditional rows based on item
// type + server-reported state.

type MenuProps = {
    itemId: string;
    itemName: string;
    itemType: string;
    editTargetId: string;
    editTargetName: string;
    isMarkable: boolean;
    isSeason: boolean;
    played?: boolean;
    token: string;
    previewQuery: string;
    onClose: () => void;
    onTags: () => void;
    onHide: () => void;
    onContentTime: () => void;
    onGlobalTime: () => void;
    onMode: () => void;
    onDim: () => void;
    onWarm: () => void;
    onBodyBreaks: () => void;
    onAutoOff: () => void;
    onMarkPlayed: (played: boolean) => void;
    onQR: (url: string) => void;
};

function MenuView({
    itemName,
    itemType,
    editTargetName,
    isMarkable,
    isSeason,
    played,
    onClose,
    onTags,
    onHide,
    onContentTime,
    onGlobalTime,
    onMode,
    onDim,
    onWarm,
    onBodyBreaks,
    onAutoOff,
    onMarkPlayed,
}: MenuProps) {
    const time = useTimeStatus();
    const breaks = useBodyBreakStatus(false);
    const viewing = useViewingState();
    const mode = useActiveMode();

    // Server status drives "is this row even relevant" gates. Per-
    // content time limit isn't surfaced by the API today; we use the
    // global enabled flag as a proxy - when the kid has no daily
    // limit at all, no per-item override makes sense either.
    const hasContentTimeLimit = !!time?.enabled;
    const hasGlobalTimeLimit = !!time?.enabled;
    const hasBodyBreaks = !!breaks?.enabled;
    const hasAutoOff =
        !!viewing && (!!viewing.sleepTimerAt || viewing.autoOffActive);
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
            onActivate: onTags,
        },
        {
            key: "hide",
            icon: <IconHide />,
            label: `Hide ${editTargetName}`,
            onActivate: onHide,
        },
    ];
    if (hasContentTimeLimit) {
        manage.push({
            key: "contentTime",
            icon: <IconClock />,
            label: `Adjust time limit (${editTargetName})`,
            onActivate: onContentTime,
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
        onActivate: onMode,
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
        onActivate: onDim,
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
        onActivate: onWarm,
        reset: warmOv
            ? {
                  label: `Reset ${warmOv.percent}% override`,
                  onActivate: () => overrides.clearWarm(),
              }
            : undefined,
    });

    if (hasGlobalTimeLimit) {
        system.push({
            key: "globalTime",
            icon: <IconClock />,
            label: `Adjust daily time (${time.minutesRemaining}m left)`,
            onActivate: onGlobalTime,
            reset: globalTimeOv
                ? {
                      label: "Reset time override",
                      onActivate: () => overrides.clearGlobalTime(),
                  }
                : undefined,
        });
    }

    if (hasBodyBreaks) {
        system.push({
            key: "bodyBreaks",
            icon: <IconBreak />,
            label: "Disable body breaks",
            onActivate: onBodyBreaks,
            reset: bodyBreaksOv
                ? {
                      label: "Reset breaks override",
                      onActivate: () => overrides.clearBodyBreaks(),
                  }
                : undefined,
        });
    }

    if (hasAutoOff) {
        system.push({
            key: "autoOff",
            icon: <IconAutoOff />,
            label: "Override auto-off",
            onActivate: onAutoOff,
            reset: autoOffOv
                ? {
                      label: "Reset auto-off override",
                      onActivate: () => overrides.clearAutoOff(),
                  }
                : undefined,
        });
    }

    return (
        <ModalShell title="Adult menu" subtitle={`${itemType}: ${itemName}`}>
            <MenuSections
                sections={[
                    { heading: `Manage ${editTargetName}`, rows: manage },
                    { heading: "System", rows: system },
                ]}
            />
            <BackLink onActivate={onClose} label="Done" />
        </ModalShell>
    );
}

type MenuRow = {
    key: string;
    icon: React.ReactNode;
    label: string;
    onActivate: () => void;
    /** When set, render a paired secondary button to the right
     *  that clears an active override without leaving the menu. */
    reset?: { label: string; onActivate: () => void };
};

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

// HideConfirmView: confirm before mutating the kid's library.

type HideConfirmProps = {
    itemId: string;
    itemName: string;
    itemType: string;
    token: string;
    previewQuery: string;
    onCancel: () => void;
    onDone: (message: string) => void;
};

function HideConfirmView({
    itemId,
    itemName,
    itemType,
    token,
    previewQuery,
    onCancel,
    onDone,
}: HideConfirmProps) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    async function confirm() {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(
                `/api/kids/override/items/${encodeURIComponent(itemId)}/hide${previewQuery}`,
                {
                    method: "POST",
                    credentials: "same-origin",
                    headers: {
                        ...authHeaders(),
                        "X-Override-Token": token,
                    },
                },
            );
            if (!res.ok) throw new Error(`${res.status}`);
            // Tell the active page to evict the item from its
            // in-memory state + caches without a full refetch
            // (which would re-randomize rows). Pages listen via
            // useItemHiddenEvent below.
            window.dispatchEvent(
                new CustomEvent("jellybean:item-hidden", {
                    detail: { itemId },
                }),
            );
            onDone(`Hidden ${itemName} from this kid's library.`);
        } catch (err) {
            setError(err instanceof Error ? err.message : "failed");
        } finally {
            setBusy(false);
        }
    }
    return (
        <ModalShell
            title={`Hide ${itemType.toLowerCase()}?`}
            subtitle={itemName}
        >
            <p className="muted">
                {itemName} won't appear in this kid's library until a parent
                un-hides it from /admin.
            </p>
            {error && <div className="error">{error}</div>}
            <ActionList
                items={[
                    {
                        key: "cancel",
                        label: "Cancel",
                        onActivate: onCancel,
                        autoFocus: true,
                    },
                    {
                        key: "confirm",
                        label: busy ? "Hiding…" : "Confirm hide",
                        onActivate: confirm,
                        disabled: busy,
                        danger: true,
                    },
                ]}
            />
        </ModalShell>
    );
}

// ContentTimeView / GlobalTimeView: pick a duration adjust.

type ContentTimeProps = {
    itemId: string;
    itemName: string;
    onBack: () => void;
    onDone: (message: string) => void;
};

function ContentTimeView({
    itemId,
    itemName,
    onBack,
    onDone,
}: ContentTimeProps) {
    return (
        <DurationPickerView
            title={`Adjust time limit for ${itemName}`}
            options={ADJUST_TIME}
            onBack={onBack}
            onPick={(opt) => {
                const adj = opt as AdjustOpt;
                if (adj.clear) {
                    overrides.clearContentTime(itemId);
                    onDone(`Time-limit override cleared for ${itemName}.`);
                    return;
                }
                if (adj.untilMidnight) {
                    const until = nextLocalMidnight();
                    overrides.setContentTime(itemId, {
                        disabledUntil: until,
                        expiresAt: until,
                    });
                    onDone(
                        `${itemName} unlimited until ${formatExpiresShort(until)}.`,
                    );
                    return;
                }
                if (!adj.addedMinutes) return;
                const expiresAt = nextLocalMidnight();
                overrides.setContentTime(itemId, {
                    addedMinutes:
                        (overrides.getContentTime(itemId)?.addedMinutes ?? 0) +
                        adj.addedMinutes,
                    expiresAt,
                });
                onDone(`+${adj.addedMinutes}m for ${itemName} (today).`);
            }}
        />
    );
}

function GlobalTimeView({
    onBack,
    onDone,
}: {
    onBack: () => void;
    onDone: (message: string) => void;
}) {
    return (
        <DurationPickerView
            title="Adjust daily time limit"
            options={ADJUST_TIME}
            onBack={onBack}
            onPick={(opt) => {
                const adj = opt as AdjustOpt;
                if (adj.clear) {
                    overrides.clearGlobalTime();
                    onDone("Daily-limit override cleared.");
                    return;
                }
                if (adj.untilMidnight) {
                    const until = nextLocalMidnight();
                    overrides.setGlobalTime({
                        disabledUntil: until,
                        expiresAt: until,
                    });
                    onDone(`Unlimited until ${formatExpiresShort(until)}.`);
                    return;
                }
                if (!adj.addedMinutes) return;
                const expiresAt = nextLocalMidnight();
                overrides.setGlobalTime({
                    addedMinutes:
                        (overrides.getGlobalTime()?.addedMinutes ?? 0) +
                        adj.addedMinutes,
                    expiresAt,
                });
                onDone(`+${adj.addedMinutes}m to today's daily limit.`);
            }}
        />
    );
}

// ModeActionView: split point for "disable current" vs "turn on".

type ModeActionProps = {
    onBack: () => void;
    onDisable: (modeName?: string) => void;
    onTurnOn: () => void;
};

function ModeActionView({ onBack, onDisable, onTurnOn }: ModeActionProps) {
    const mode = useActiveMode();
    const active = mode?.mode;
    const items: { key: string; label: string; onActivate: () => void }[] = [];
    if (active) {
        items.push({
            key: "disable",
            label: `Disable ${active.name}`,
            onActivate: () => onDisable(active.name),
        });
    }
    items.push({
        key: "turn-on",
        label: active ? "Switch to a different mode" : "Turn on a mode",
        onActivate: onTurnOn,
    });
    return (
        <ModalShell
            title="Mode override"
            subtitle={active ? `Currently ${active.name}` : "No mode active"}
        >
            <ActionList items={items} />
            <BackLink onActivate={onBack} />
        </ModalShell>
    );
}

// ModePickerView: list of modes from server.

function ModePickerView({
    onBack,
    onPick,
}: {
    onBack: () => void;
    onPick: (modeId: number, modeName: string) => void;
}) {
    const mode = useActiveMode();
    const available = mode?.available ?? (mode?.mode ? [mode.mode] : []);
    if (available.length === 0) {
        return (
            <ModalShell title="No modes configured">
                <p className="muted">No modes have been set up.</p>
                <BackLink autoFocus onActivate={onBack} />
            </ModalShell>
        );
    }
    return (
        <ModalShell title="Pick a mode">
            <ActionList
                items={available.map((m) => ({
                    key: String(m.id),
                    label: m.name,
                    onActivate: () => onPick(m.id, m.name),
                }))}
            />
            <BackLink onActivate={onBack} />
        </ModalShell>
    );
}

// ViewingSetupView: dim or warm slider (left/right by 5%) + duration
// picker. Live preview shows the combined filter (this control's
// new value plus the OTHER control's existing override / server
// value).

type ViewingSetupProps = {
    control: "dim" | "warm";
    onBack: () => void;
    onDone: (message: string) => void;
};

// Hard ceiling for dim: the kid TV's WebView can't easily recover
// from a fully-dimmed screen (no obvious affordance for "you set
// dim to 100, undo it"). Cap at 90 so something is always visible.
const DIM_MAX_PERCENT = 90;
const WARM_MAX_PERCENT = 100;

function ViewingSetupView({ control, onBack, onDone }: ViewingSetupProps) {
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

// AutoOffView: disable-until-tomorrow vs temporary shift entry.

function AutoOffView({
    onBack,
    onDisableUntilTomorrow,
    onShift,
}: {
    onBack: () => void;
    onDisableUntilTomorrow: () => void;
    onShift: () => void;
}) {
    return (
        <ModalShell title="Override auto-off">
            <ActionList
                items={[
                    {
                        key: "tomorrow",
                        label: "Disable until tomorrow",
                        onActivate: onDisableUntilTomorrow,
                    },
                    {
                        key: "shift",
                        label: "Shift the time (±15m)",
                        onActivate: onShift,
                    },
                ]}
            />
            <BackLink onActivate={onBack} />
        </ModalShell>
    );
}

function AutoOffShiftView({
    onBack,
    onSave,
}: {
    onBack: () => void;
    onSave: (deltaMinutes: number) => void;
}) {
    const viewing = useViewingState();
    const [delta, setDelta] = useState(0);
    const baseTime = viewing?.sleepTimerAt
        ? new Date(viewing.sleepTimerAt)
        : null;
    const shiftedTime = baseTime
        ? new Date(baseTime.getTime() + delta * 60_000)
        : null;
    // Bounds: shifted time must be in [now, next local midnight].
    // Earliest delta = now - baseTime; latest delta = midnight -
    // baseTime. Computed per-render so the bounds advance as the
    // clock ticks.
    const minDelta = baseTime
        ? Math.ceil((Date.now() - baseTime.getTime()) / 60_000)
        : 0;
    const maxDelta = baseTime
        ? Math.floor(
              (Date.parse(nextLocalMidnight()) - baseTime.getTime()) / 60_000,
          )
        : 0;
    const ref = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        ref.current?.focus();
    }, []);
    function onKey(e: React.KeyboardEvent) {
        if (e.key === "ArrowUp") {
            e.preventDefault();
            setDelta((d) => Math.min(maxDelta, d + SHIFT_STEP_MIN));
            return;
        }
        if (e.key === "ArrowDown") {
            e.preventDefault();
            setDelta((d) => Math.max(minDelta, d - SHIFT_STEP_MIN));
            return;
        }
    }
    return (
        <ModalShell title="Shift auto-off time">
            <div className="muted">
                Configured:{" "}
                {baseTime
                    ? baseTime.toLocaleTimeString([], {
                          hour: "numeric",
                          minute: "2-digit",
                      })
                    : "(no clock-off set)"}
            </div>
            <div
                ref={ref}
                tabIndex={0}
                role="spinbutton"
                aria-label="Auto-off shift"
                className="override-shift"
                onKeyDown={onKey}
            >
                <div className="override-shift-delta">
                    {delta >= 0 ? "+" : ""}
                    {delta} min
                </div>
                <div className="override-shift-target">
                    Today:{" "}
                    {shiftedTime
                        ? shiftedTime.toLocaleTimeString([], {
                              hour: "numeric",
                              minute: "2-digit",
                          })
                        : "—"}
                </div>
                <div className="muted">
                    Up = later · Down = earlier · clamps to now / midnight
                </div>
            </div>
            <ActionList
                items={[
                    {
                        key: "save",
                        label: "Save",
                        onActivate: () => onSave(delta),
                        disabled: delta === 0,
                    },
                ]}
            />
            <BackLink onActivate={onBack} />
        </ModalShell>
    );
}

// DurationPickerView: shared pattern for "pick a duration / adjust"
// with a generic option type.

type DurationPickerProps = {
    title: string;
    options: { id: string; label: string }[];
    onBack: () => void;
    onPick: (option: DurationOpt | AdjustOpt) => void;
};

function DurationPickerView({
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

// ============================================================
// Reusable building blocks
// ============================================================

type ActionItem = {
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
type ActionListProps = {
    items: ActionItem[];
    noAutoFocus?: boolean;
    onExitUp?: () => void;
    onExitDown?: () => void;
    listRef?: React.RefObject<HTMLDivElement>;
};

function ActionList({
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
    function onKeyDown(i: number, e: React.KeyboardEvent) {
        if (e.key === "ArrowDown") {
            e.preventDefault();
            for (let j = i + 1; j < items.length; j++) {
                if (!items[j].disabled) {
                    refs.current[j]?.focus();
                    return;
                }
            }
            // Already on the last enabled row - hand focus off
            // to the parent if it provided an exit callback.
            if (onExitDown) onExitDown();
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
            if (onExitUp) onExitUp();
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

// BackLink: low-chrome footer that the parent visits with the
// D-pad. Renders as text + arrow icon, no full button bezel; the
// focus ring is a 1px border around the inline text. Used in
// place of ActionButton for back / done footers across the
// override views per the M9 v2 visual brief.
function BackLink({
    onActivate,
    label = "Back",
    autoFocus,
    disabled,
    icon,
}: {
    onActivate: () => void;
    label?: string;
    autoFocus?: boolean;
    disabled?: boolean;
    /** Override the default left-arrow glyph. Pass null to omit. */
    icon?: React.ReactNode | null;
}) {
    const ref = useRef<HTMLButtonElement | null>(null);
    useEffect(() => {
        if (autoFocus) ref.current?.focus();
    }, [autoFocus]);
    const glyph = icon === undefined ? <IconArrowLeft /> : icon;
    return (
        <button
            ref={ref}
            type="button"
            className="override-back-link"
            disabled={disabled}
            onClick={onActivate}
        >
            {glyph && <span className="override-back-link-icon">{glyph}</span>}
            <span>{label}</span>
        </button>
    );
}

// ============================================================
// TagsView (preserved from previous version)
// ============================================================

type TagsViewProps = {
    itemId: string;
    itemName: string;
    token: string;
    previewQuery: string;
    onBack: () => void;
    onClose: () => void;
};

function TagsView({
    itemId,
    itemName,
    token,
    previewQuery,
    onBack,
    onClose,
}: TagsViewProps) {
    const [allTags, setAllTags] = useState<Tag[] | null>(null);
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        void (async () => {
            try {
                const res = await fetch(
                    `/api/kids/override/items/${encodeURIComponent(itemId)}/tags${previewQuery}`,
                    {
                        credentials: "same-origin",
                        headers: {
                            ...authHeaders(),
                            "X-Override-Token": token,
                        },
                    },
                );
                if (!res.ok) throw new Error(`${res.status}`);
                const body = (await res.json()) as {
                    tags: Tag[];
                    selected: number[];
                };
                setAllTags(body.tags);
                setSelected(new Set(body.selected ?? []));
            } catch (err) {
                setError(err instanceof Error ? err.message : "load failed");
            }
        })();
    }, [token, itemId, previewQuery]);

    async function save() {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(
                `/api/kids/override/items/${encodeURIComponent(itemId)}/tags${previewQuery}`,
                {
                    method: "PUT",
                    credentials: "same-origin",
                    headers: {
                        ...authHeaders(),
                        "X-Override-Token": token,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({ tagIds: [...selected] }),
                },
            );
            if (!res.ok) throw new Error(`${res.status}`);
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : "save failed");
        } finally {
            setBusy(false);
        }
    }

    function toggle(id: number) {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }

    return (
        <ModalShell title="Edit tags" subtitle={itemName}>
            {error && <div className="error">{error}</div>}
            {allTags === null ? (
                <p className="muted">Loading tags…</p>
            ) : allTags.length === 0 ? (
                <p className="muted">
                    No tags exist yet. Ask a grown-up to set some up.
                </p>
            ) : (
                <TagGrid
                    tags={allTags}
                    selected={selected}
                    busy={busy}
                    onToggle={toggle}
                />
            )}
            <ActionList
                items={[
                    {
                        key: "save",
                        label: busy ? "Saving…" : "Save",
                        onActivate: save,
                        disabled: busy || allTags === null,
                        autoFocus: allTags !== null && allTags.length === 0,
                    },
                ]}
            />
            <BackLink onActivate={onBack} disabled={busy} />
        </ModalShell>
    );
}

// TagGrid: focusable button-per-tag in a 2-column grid. Up/Down
// moves between rows of the grid; Left/Right between columns.
// Down off the last row hands focus to the Save button below.
// Each button is a real focusable element with role=checkbox so
// the kid's TV remote (D-pad + Enter) can toggle without ever
// needing pointer / tab.
function TagGrid({
    tags,
    selected,
    busy,
    onToggle,
}: {
    tags: Tag[];
    selected: Set<number>;
    busy: boolean;
    onToggle: (id: number) => void;
}) {
    const refs = useRef<(HTMLButtonElement | null)[]>([]);
    const COLS = 2;
    useEffect(() => {
        refs.current[0]?.focus();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    function move(i: number, dRow: number, dCol: number): boolean {
        const row = Math.floor(i / COLS);
        const col = i % COLS;
        const nextRow = row + dRow;
        const nextCol = col + dCol;
        if (nextRow < 0) return false;
        if (nextCol < 0 || nextCol >= COLS) return false;
        const nextI = nextRow * COLS + nextCol;
        if (nextI < 0 || nextI >= tags.length) {
            // Off the end of the grid: try the same column on
            // the previous row to land somewhere useful instead
            // of bouncing.
            if (dRow > 0 && nextRow > row) {
                const lastI = tags.length - 1;
                if (lastI > i) {
                    refs.current[lastI]?.focus();
                    return true;
                }
            }
            return false;
        }
        refs.current[nextI]?.focus();
        return true;
    }

    function onKey(i: number, e: React.KeyboardEvent) {
        if (e.key === "ArrowDown") {
            e.preventDefault();
            const moved = move(i, 1, 0);
            if (!moved) {
                // Drop to the Save button below.
                const next = (e.currentTarget.closest(
                    ".override-modal",
                ) as HTMLElement | null)?.querySelector<HTMLButtonElement>(
                    ".override-action-list button:not(:disabled)",
                );
                next?.focus();
            }
            return;
        }
        if (e.key === "ArrowUp") {
            e.preventDefault();
            move(i, -1, 0);
            return;
        }
        if (e.key === "ArrowLeft") {
            e.preventDefault();
            move(i, 0, -1);
            return;
        }
        if (e.key === "ArrowRight") {
            e.preventDefault();
            move(i, 0, 1);
            return;
        }
    }

    return (
        <div className="override-tag-grid" role="group" aria-label="Tags">
            {tags.map((t, i) => {
                const isOn = selected.has(t.id);
                return (
                    <button
                        key={t.id}
                        ref={(el) => (refs.current[i] = el)}
                        type="button"
                        role="checkbox"
                        aria-checked={isOn}
                        disabled={busy}
                        className={`override-tag-chip${isOn ? " on" : ""}`}
                        onClick={() => onToggle(t.id)}
                        onKeyDown={(e) => onKey(i, e)}
                    >
                        <span className="override-tag-chip-mark" aria-hidden>
                            {isOn ? <Check size={14} weight="bold" /> : ""}
                        </span>
                        <span className="override-tag-chip-name">{t.name}</span>
                    </button>
                );
            })}
        </div>
    );
}

// ============================================================
// PinStage
// ============================================================

// PinStage is the PIN-entry view, refactored onto KidModalShell so
// the cross-cutting bits (portal, Escape -> close, repeat-Enter
// swallow, armed/keyup gate, focus trap, useProgressiveBack) live
// in the shared primitive. The PIN-specific keyboard math (arrows
// -> ULDR digit chars, Backspace -> pop, Enter -> manual submit)
// stays inline because it doesn't fit the useDpadCursor pattern.
//
// Visually identical to the previous ModalShell + adult styling -
// we render the same .override-backdrop.kids-override-adult /
// .override-modal class pair through the shell.

type PinStageProps = {
    itemName: string;
    pinDigits: string;
    pinBusy: boolean;
    pinError: string | null;
    pinFlashError: boolean;
    onClose: () => void;
    /** Called once per arrow press with "U" / "D" / "L" / "R". The
     *  parent appends, then auto-submits when the 4th digit lands. */
    onAppendDigit: (ch: "U" | "D" | "L" | "R") => void;
    onBackspace: () => void;
    onSubmit: () => void;
};

const PIN_ARROW_MAP: Record<string, "U" | "D" | "L" | "R"> = {
    ArrowUp: "U",
    ArrowDown: "D",
    ArrowLeft: "L",
    ArrowRight: "R",
};

function PinStage({
    itemName,
    pinDigits,
    pinBusy,
    pinError,
    pinFlashError,
    onClose,
    onAppendDigit,
    onBackspace,
    onSubmit,
}: PinStageProps) {
    // Mirror callbacks via refs so the listener attaches once and
    // reads latest values without re-binding.
    const onAppendRef = useRef(onAppendDigit);
    onAppendRef.current = onAppendDigit;
    const onBackspaceRef = useRef(onBackspace);
    onBackspaceRef.current = onBackspace;
    const onSubmitRef = useRef(onSubmit);
    onSubmitRef.current = onSubmit;

    // Window capture-phase keydown for PIN-specific input.
    // KidModalShell already swallowed Escape -> close, repeat-Enter,
    // and pre-arm Enter. We pass closeOnBackspace=false on the shell
    // so Backspace falls through here to delete a digit (matches
    // the original desktop behavior; the TV remote routes hardware
    // Back through useProgressiveBack independent of Backspace).
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const k = e.key;
            const arrow = PIN_ARROW_MAP[k];
            if (arrow !== undefined) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                onAppendRef.current(arrow);
                return;
            }
            if (k === "Backspace") {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                onBackspaceRef.current();
                return;
            }
            if (k === "Enter" || k === " ") {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                onSubmitRef.current();
                return;
            }
        };
        window.addEventListener("keydown", onKey, { capture: true });
        return () =>
            window.removeEventListener("keydown", onKey, { capture: true });
    }, []);

    return (
        <KidModalShell
            onClose={onClose}
            ariaLabel="Adult pattern"
            backdropClassName="override-backdrop kids-override-adult"
            cardClassName="override-modal"
            variant="adult"
            closeOnBackspace={false}
        >
            <h2>Adult pattern</h2>
            <p className="muted">
                Press the 4-step arrow pattern for "{itemName}".
            </p>
            <div
                className={`override-pin-display ${pinFlashError ? "error-flash" : ""}`}
                role="status"
                aria-label="Pattern progress"
            >
                {[0, 1, 2, 3].map((i) => (
                    <span
                        key={i}
                        className={`override-pin-dot ${i < pinDigits.length ? "filled" : ""}`}
                    />
                ))}
            </div>
            {pinError && <div className="error">{pinError}</div>}
            <p className="muted override-pin-hint">
                Use the remote's arrow keys. We never show what you press.
                Press Back to close.
            </p>
            {pinBusy && <p className="muted">Checking…</p>}
        </KidModalShell>
    );
}

// ============================================================
// ModalShell
// ============================================================

type ModalShellProps = {
    title: string;
    subtitle?: string;
    children: React.ReactNode;
};

function ModalShell({ title, subtitle, children }: ModalShellProps) {
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
// useLongPressEnter (preserved)
// ============================================================

// Long-press hook used by Browse/Library/TagDetail/Watch. Detects
// short vs long Enter (D-pad center) on the focused tile and
// dispatches to onShortPress (play) or onLongPress (open this
// modal). Capture-phase + preventDefault so the page's own Enter
// handler doesn't double-fire.
//
// e.repeat is swallowed: held Enter doesn't re-arm.
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
