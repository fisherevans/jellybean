import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { authHeaders } from "./auth";

// Adult override modal (M9 #55/#56). PIN-gated edit menu for the
// kid TV. Flow:
//   1. Long-press UP on a tile -> Browse opens this modal.
//   2. Modal first renders the PIN entry; on success, the menu of
//      action sub-views.
//   3. Each sub-view talks to /api/kids/override/items/{id}/<action>
//      with the X-Override-Token header.
//   4. Closing the modal calls /api/kids/override/end so a fresh
//      gesture re-prompts for the PIN.
//
// PIN UI: simple 4-digit numeric pad. Number keys + backspace work
// from a standard keyboard; D-pad on the TV is wired via tabIndex
// + keydown handlers on the buttons.

type Tag = { id: number; name: string };

type Props = {
    itemId: string;
    itemName: string;
    onClose: () => void;
};

type Stage =
    | { kind: "pin" }
    | { kind: "menu"; token: string }
    | { kind: "tags"; token: string }
    | { kind: "qr"; token: string; url: string }
    | { kind: "error"; message: string }
    | { kind: "done"; message: string };

export default function OverrideModal({ itemId, itemName, onClose }: Props) {
    const [stage, setStage] = useState<Stage>({ kind: "pin" });
    const [pinDigits, setPinDigits] = useState<string>("");
    const [pinBusy, setPinBusy] = useState(false);
    const [pinError, setPinError] = useState<string | null>(null);

    const closeRef = useRef(onClose);
    closeRef.current = onClose;

    // Sliding TTL: while the menu is open and the user is touching
    // anything, fire /refresh every 30s so the 60s session doesn't
    // expire mid-action.
    const tokenForRefresh = stage.kind !== "pin" && stage.kind !== "error"
        ? (stage as { token?: string }).token ?? ""
        : "";
    useEffect(() => {
        if (!tokenForRefresh) return;
        const id = setInterval(() => {
            void fetch("/api/kids/override/refresh", {
                method: "POST",
                credentials: "same-origin",
                headers: { ...authHeaders(), "X-Override-Token": tokenForRefresh },
            });
        }, 30_000);
        return () => clearInterval(id);
    }, [tokenForRefresh]);

    // End the session on close so the next gesture re-prompts.
    useEffect(() => {
        return () => {
            void fetch("/api/kids/override/end", {
                method: "POST",
                credentials: "same-origin",
                headers: authHeaders(),
            });
        };
    }, []);

    // Esc closes from any stage.
    useEffect(() => {
        function onKey(e: KeyboardEvent) {
            if (e.key === "Escape") closeRef.current();
        }
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    // PIN input: digit keys 0-9 + Backspace + Enter.
    useEffect(() => {
        if (stage.kind !== "pin") return;
        function onKey(e: KeyboardEvent) {
            if (pinBusy) return;
            if (e.key === "Backspace") {
                setPinDigits((d) => d.slice(0, -1));
                e.preventDefault();
                return;
            }
            if (e.key === "Enter") {
                void submitPIN();
                e.preventDefault();
                return;
            }
            if (/^[0-9]$/.test(e.key) && pinDigits.length < 8) {
                setPinDigits((d) => d + e.key);
                e.preventDefault();
            }
        }
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [stage.kind, pinDigits, pinBusy]);

    async function submitPIN() {
        if (pinDigits.length < 4) {
            setPinError("Enter at least 4 digits.");
            return;
        }
        setPinBusy(true);
        setPinError(null);
        try {
            const res = await fetch("/api/kids/override/verify-pin", {
                method: "POST",
                credentials: "same-origin",
                headers: { ...authHeaders(), "Content-Type": "application/json" },
                body: JSON.stringify({ pin: pinDigits }),
            });
            if (res.status === 423 || res.status === 423 /* Locked */) {
                const retry = res.headers.get("Retry-After") ?? "60";
                setPinError(`Locked out. Try again in ${retry}s.`);
                return;
            }
            if (res.status === 412) {
                setStage({
                    kind: "error",
                    message: "No PIN configured. Ask a grown-up to set one in /admin/settings.",
                });
                return;
            }
            if (res.status === 401) {
                setPinError("Wrong PIN.");
                setPinDigits("");
                return;
            }
            if (!res.ok) {
                setPinError(`Server error (${res.status}). Try again later.`);
                return;
            }
            const body = (await res.json()) as { token: string };
            setStage({ kind: "menu", token: body.token });
            setPinDigits("");
        } catch (err) {
            setPinError(err instanceof Error ? err.message : "request failed");
        } finally {
            setPinBusy(false);
        }
    }

    if (stage.kind === "error") {
        return (
            <ModalShell onClose={onClose} title="Override unavailable">
                <p>{stage.message}</p>
                <button onClick={onClose}>Close</button>
            </ModalShell>
        );
    }
    if (stage.kind === "done") {
        return (
            <ModalShell onClose={onClose} title="Done">
                <p>{stage.message}</p>
                <button onClick={onClose}>Close</button>
            </ModalShell>
        );
    }

    if (stage.kind === "pin") {
        return (
            <ModalShell onClose={onClose} title="Enter PIN">
                <p className="muted">Adult override for "{itemName}"</p>
                <div className="override-pin-display" role="status" aria-label="PIN">
                    {[0, 1, 2, 3].map((i) => (
                        <span
                            key={i}
                            className={`override-pin-dot ${i < pinDigits.length ? "filled" : ""}`}
                        />
                    ))}
                    {pinDigits.length > 4 ? (
                        <span className="override-pin-extra">
                            +{pinDigits.length - 4}
                        </span>
                    ) : null}
                </div>
                {pinError && <div className="error">{pinError}</div>}
                <PinPad
                    onDigit={(d) =>
                        setPinDigits((cur) => (cur.length < 8 ? cur + d : cur))
                    }
                    onBackspace={() => setPinDigits((d) => d.slice(0, -1))}
                    onSubmit={submitPIN}
                    disabled={pinBusy}
                />
                <button
                    className="override-cancel"
                    onClick={onClose}
                    disabled={pinBusy}
                >
                    Cancel
                </button>
            </ModalShell>
        );
    }

    if (stage.kind === "tags") {
        return (
            <TagsView
                itemId={itemId}
                itemName={itemName}
                token={stage.token}
                onBack={() => setStage({ kind: "menu", token: stage.token })}
                onClose={onClose}
            />
        );
    }

    if (stage.kind === "qr") {
        return (
            <ModalShell onClose={onClose} title="Open on your phone">
                <p className="muted">
                    Scan to manage "{itemName}" from a browser.
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
                <button onClick={() => setStage({ kind: "menu", token: stage.token })}>
                    Back
                </button>
            </ModalShell>
        );
    }

    // stage === menu
    return (
        <MenuView
            itemId={itemId}
            itemName={itemName}
            token={stage.token}
            onClose={onClose}
            onTags={() => setStage({ kind: "tags", token: stage.token })}
            onQR={(url) => setStage({ kind: "qr", token: stage.token, url })}
            onDone={(msg) => setStage({ kind: "done", message: msg })}
        />
    );
}

type MenuProps = {
    itemId: string;
    itemName: string;
    token: string;
    onClose: () => void;
    onTags: () => void;
    onQR: (url: string) => void;
    onDone: (message: string) => void;
};

function MenuView({ itemId, itemName, token, onClose, onTags, onQR, onDone }: MenuProps) {
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    async function call(label: string, path: string, init?: RequestInit) {
        setBusy(label);
        setError(null);
        try {
            const res = await fetch(path, {
                ...(init ?? {}),
                credentials: "same-origin",
                headers: {
                    ...authHeaders(),
                    "X-Override-Token": token,
                    ...((init?.headers as Record<string, string>) ?? {}),
                    ...(init?.body ? { "Content-Type": "application/json" } : {}),
                },
            });
            if (!res.ok) {
                throw new Error(`${res.status} ${res.statusText}`);
            }
            return res;
        } catch (err) {
            setError(err instanceof Error ? err.message : "request failed");
            throw err;
        } finally {
            setBusy(null);
        }
    }

    async function favoriteAdd() {
        await call("favorite", `/api/kids/override/items/${encodeURIComponent(itemId)}/favorite`, {
            method: "POST",
            body: JSON.stringify({ state: "add" }),
        });
        onDone("Added to favorites.");
    }
    async function favoriteRemove() {
        await call("unfavorite", `/api/kids/override/items/${encodeURIComponent(itemId)}/favorite`, {
            method: "POST",
            body: JSON.stringify({ state: "remove" }),
        });
        onDone("Removed from favorites.");
    }
    async function hide() {
        await call("hide", `/api/kids/override/items/${encodeURIComponent(itemId)}/hide`, {
            method: "POST",
        });
        onDone("Hidden.");
    }
    async function markPlayed() {
        await call("mark-played", `/api/kids/override/items/${encodeURIComponent(itemId)}/mark/played`, {
            method: "POST",
        });
        onDone("Marked as watched.");
    }
    async function markUnplayed() {
        await call("mark-unplayed", `/api/kids/override/items/${encodeURIComponent(itemId)}/mark/unplayed`, {
            method: "POST",
        });
        onDone("Marked as unwatched.");
    }
    async function showQR() {
        const res = await call("qr", `/api/kids/override/items/${encodeURIComponent(itemId)}/qr`, {
            method: "GET",
        });
        const body = (await res.json()) as { url: string };
        onQR(body.url);
    }

    return (
        <ModalShell onClose={onClose} title="Adult menu">
            <p className="muted">{itemName}</p>
            {error && <div className="error">{error}</div>}
            <div className="override-action-grid">
                <button
                    onClick={favoriteAdd}
                    disabled={busy !== null}
                >
                    {busy === "favorite" ? "Adding…" : "Add to favorites"}
                </button>
                <button
                    onClick={favoriteRemove}
                    disabled={busy !== null}
                >
                    Remove favorite
                </button>
                <button onClick={onTags} disabled={busy !== null}>
                    Edit tags
                </button>
                <button onClick={hide} disabled={busy !== null}>
                    Hide for this kid
                </button>
                <button onClick={markPlayed} disabled={busy !== null}>
                    Mark watched
                </button>
                <button onClick={markUnplayed} disabled={busy !== null}>
                    Mark unwatched
                </button>
                <button onClick={showQR} disabled={busy !== null}>
                    Open on phone (QR)
                </button>
            </div>
            <button className="override-cancel" onClick={onClose}>
                Done
            </button>
        </ModalShell>
    );
}

type TagsViewProps = {
    itemId: string;
    itemName: string;
    token: string;
    onBack: () => void;
    onClose: () => void;
};

function TagsView({ itemId, itemName, token, onBack, onClose }: TagsViewProps) {
    const [allTags, setAllTags] = useState<Tag[] | null>(null);
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        // GET on the same gated path returns { tags, selected } so
        // the kid client can render the picker without needing admin
        // auth. Server-side this is the same handler that PUT writes
        // to but with a different method.
        void (async () => {
            try {
                const res = await fetch(
                    `/api/kids/override/items/${encodeURIComponent(itemId)}/tags`,
                    {
                        credentials: "same-origin",
                        headers: { ...authHeaders(), "X-Override-Token": token },
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
    }, [token, itemId]);

    async function save() {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(
                `/api/kids/override/items/${encodeURIComponent(itemId)}/tags`,
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

    return (
        <ModalShell onClose={onClose} title="Edit tags">
            <p className="muted">{itemName}</p>
            {error && <div className="error">{error}</div>}
            {allTags === null ? (
                <p className="muted">Loading tags…</p>
            ) : allTags.length === 0 ? (
                <p className="muted">
                    No tags exist yet. Ask a grown-up to set some up.
                </p>
            ) : (
                <ul className="override-tag-list">
                    {allTags.map((t) => (
                        <li key={t.id}>
                            <label>
                                <input
                                    type="checkbox"
                                    checked={selected.has(t.id)}
                                    onChange={(e) => {
                                        const next = new Set(selected);
                                        if (e.target.checked) next.add(t.id);
                                        else next.delete(t.id);
                                        setSelected(next);
                                    }}
                                    disabled={busy}
                                />
                                <span>{t.name}</span>
                            </label>
                        </li>
                    ))}
                </ul>
            )}
            <div className="override-action-row">
                <button onClick={onBack} disabled={busy}>
                    Back
                </button>
                <button onClick={save} disabled={busy || allTags === null}>
                    {busy ? "Saving…" : "Save"}
                </button>
            </div>
        </ModalShell>
    );
}

type ModalShellProps = {
    onClose: () => void;
    title: string;
    children: React.ReactNode;
};

function ModalShell({ onClose, title, children }: ModalShellProps) {
    return (
        <div className="override-backdrop" onClick={onClose}>
            <div
                className="override-modal"
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-label={title}
            >
                <h2>{title}</h2>
                {children}
            </div>
        </div>
    );
}

type PinPadProps = {
    onDigit: (d: string) => void;
    onBackspace: () => void;
    onSubmit: () => void;
    disabled: boolean;
};

function PinPad({ onDigit, onBackspace, onSubmit, disabled }: PinPadProps) {
    const buttons = useMemo(
        () => [
            "1", "2", "3",
            "4", "5", "6",
            "7", "8", "9",
            "back", "0", "ok",
        ],
        [],
    );
    return (
        <div className="override-pinpad" role="group" aria-label="PIN pad">
            {buttons.map((b) => (
                <button
                    key={b}
                    type="button"
                    className={`override-pinpad-btn ${b === "back" || b === "ok" ? "is-action" : ""}`}
                    disabled={disabled}
                    onClick={() => {
                        if (b === "back") onBackspace();
                        else if (b === "ok") onSubmit();
                        else onDigit(b);
                    }}
                >
                    {b === "back" ? "⌫" : b === "ok" ? "OK" : b}
                </button>
            ))}
        </div>
    );
}

// Long-press hook used by Browse.tsx (and any future page) to
// detect a sustained UP keypress on a focused tile + open the
// override modal.
//
// Implementation: track the keyDown timestamp of an UP key; if
// keyUp arrives before LONG_PRESS_MS, treat as a normal up. If
// LONG_PRESS_MS elapses without keyUp, fire onLongPress with the
// current focus target.
export function useLongPressUp(
    onLongPress: () => void,
    enabled: boolean,
    longPressMs = 600,
): void {
    const timer = useRef<number | null>(null);
    const fired = useRef(false);
    const handler = useCallback(
        (e: KeyboardEvent) => {
            if (!enabled) return;
            if (e.key !== "ArrowUp") return;
            if (e.repeat) return; // already counted by the first event
            fired.current = false;
            timer.current = window.setTimeout(() => {
                fired.current = true;
                onLongPress();
            }, longPressMs);
        },
        [enabled, longPressMs, onLongPress],
    );
    const upHandler = useCallback(() => {
        if (timer.current !== null) {
            window.clearTimeout(timer.current);
            timer.current = null;
        }
    }, []);
    useEffect(() => {
        if (!enabled) return;
        window.addEventListener("keydown", handler);
        window.addEventListener("keyup", upHandler);
        return () => {
            window.removeEventListener("keydown", handler);
            window.removeEventListener("keyup", upHandler);
            if (timer.current !== null) window.clearTimeout(timer.current);
        };
    }, [enabled, handler, upHandler]);
}
