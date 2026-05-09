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
// This file is the host. It owns the stage stack, the PIN flow,
// the session-reuse window, and the token refresh ticker. Each
// stage's content lives in its own file under override/ and
// receives a StageCtx for navigation. See override/types.ts for
// the Stage union and StageCtx contract.
//
// PinStage wraps KidModalShell (the shared kid-app modal primitive)
// for portal / Escape / repeat-Enter swallow / armed gate / focus
// trap. Other stages still use override/shell.tsx's ModalShell -
// porting them onto KidModalShell is a separate follow-up.

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { authHeaders } from "./auth";
import { useProgressiveBack } from "./useProgressiveBack";
import { ModalShell, BackLink } from "./override/shell";
import { IconConfirmCheck } from "./override/icons";
import type { Stage, StageCtx } from "./override/types";
import { MenuView } from "./override/MenuSections";
import { PinStage } from "./override/PinStage";
import { TagsStage } from "./override/Tags";
import { HideConfirmStage } from "./override/Hide";
import { ContentTimeStage } from "./override/ContentTime";
import { GlobalTimeStage } from "./override/GlobalTime";
import { ModeActionStage } from "./override/ModeAction";
import { ModePickerStage } from "./override/ModePicker";
import { ModeDurationStage } from "./override/ModeDuration";
import { DimSetupStage } from "./override/DimSetup";
import { WarmSetupStage } from "./override/WarmSetup";
import { BodyBreaksStage } from "./override/BodyBreaks";
import { AutoOffStage, AutoOffShiftStage } from "./override/AutoOff";
import { QrStage } from "./override/QR";

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
    const pop = () =>
        setStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
    const replaceTop = (s: Stage) =>
        setStack((prev) => [...prev.slice(0, -1), s]);

    const closeRef = useRef(onClose);
    closeRef.current = onClose;

    // StageCtx is the navigation handle handed to every per-stage
    // file. Stable identity (memoized on previewQuery) so the per-
    // stage renderers don't churn deps.
    const ctx: StageCtx = useMemo(
        () => ({
            push,
            pop,
            replaceTop,
            close: () => closeRef.current(),
            previewQuery,
        }),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [previewQuery],
    );

    // PIN entry state. The PIN stage's keyboard listener +
    // armed/keyup gate + portal/Escape/repeat-Enter swallow live in
    // PinStage which wraps KidModalShell. Other stages keep using
    // override/shell.tsx's ModalShell + their own listeners.
    const [pinDigits, setPinDigits] = useState<string>("");
    const [pinBusy, setPinBusy] = useState(false);
    const [pinError, setPinError] = useState<string | null>(null);
    const [pinFlashError, setPinFlashError] = useState(false);

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
            <QrStage
                ctx={ctx}
                url={stage.url}
                editTargetName={editTargetName}
            />
        );
    }

    if (stage.kind === "tags") {
        return (
            <TagsStage
                ctx={ctx}
                token={stage.token}
                itemId={editTargetId}
                itemName={editTargetName}
            />
        );
    }

    if (stage.kind === "hideConfirm") {
        return (
            <HideConfirmStage
                ctx={ctx}
                token={stage.token}
                itemId={editTargetId}
                itemName={editTargetName}
                itemType={itemType}
            />
        );
    }

    if (stage.kind === "contentTime") {
        return (
            <ContentTimeStage
                ctx={ctx}
                itemId={editTargetId}
                itemName={editTargetName}
            />
        );
    }

    if (stage.kind === "globalTime") {
        return <GlobalTimeStage ctx={ctx} />;
    }

    if (stage.kind === "modeAction") {
        return <ModeActionStage ctx={ctx} token={stage.token} />;
    }

    if (stage.kind === "modePicker") {
        return <ModePickerStage ctx={ctx} token={stage.token} />;
    }

    if (stage.kind === "modeDuration") {
        return (
            <ModeDurationStage
                ctx={ctx}
                intent={stage.intent}
                modeId={stage.modeId}
                modeName={stage.modeName}
            />
        );
    }

    if (stage.kind === "dimSetup") {
        return <DimSetupStage ctx={ctx} />;
    }

    if (stage.kind === "warmSetup") {
        return <WarmSetupStage ctx={ctx} />;
    }

    if (stage.kind === "bodyBreaks") {
        return <BodyBreaksStage ctx={ctx} />;
    }

    if (stage.kind === "autoOff") {
        return <AutoOffStage ctx={ctx} token={stage.token} />;
    }

    if (stage.kind === "autoOffShift") {
        return <AutoOffShiftStage ctx={ctx} />;
    }

    // stage.kind === "menu"
    return (
        <MenuView
            ctx={ctx}
            token={stage.token}
            itemId={itemId}
            itemName={itemName}
            itemType={itemType}
            editTargetId={editTargetId}
            editTargetName={editTargetName}
            isMarkable={isMarkable}
            isSeason={isSeason}
            played={played}
            onMarkPlayed={(p) => {
                void doMark(
                    stage.token,
                    previewQuery,
                    itemId,
                    itemType,
                    p,
                    replaceTop,
                );
            }}
            onQR={(url) => push({ kind: "qr", token: stage.token, url })}
        />
    );
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

// useLongPressEnter is the long-press hook used by
// Browse/Library/TagDetail/Watch to open this modal on a held
// Enter. It lives in its own file (./useLongPressEnter) but is
// re-exported here so existing import sites
// (`import OverrideModal, { useLongPressEnter } from
// "./OverrideModal"`) keep working.
export { useLongPressEnter } from "./useLongPressEnter";
