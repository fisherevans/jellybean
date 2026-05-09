import { useEffect, useRef, useState } from "react";
import { api, HttpError, type User } from "../api";

// Admin login. Two paths:
//
// 1. Quick Connect (default when the upstream Jellyfin admin has it
//    enabled): the admin enters the 6-digit code on a Jellyfin client
//    they're already signed into. Server polls Jellyfin every ~3s and
//    mints our session cookie when approval lands. Same cadence as
//    the kid TV path.
//
// 2. Username/password (always available): same form as before.

const POLL_INTERVAL_MS = 3000;

type Mode = "loading" | "qc" | "password";

type Props = {
    onSuccess: (u: User) => void;
};

export default function Login({ onSuccess }: Props) {
    const [mode, setMode] = useState<Mode>("loading");
    const [error, setError] = useState<string | null>(null);

    // Probe whether QC is enabled. Defaults to QC when the server
    // says yes - parents typing on a phone is one less password.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await api.quickConnectEnabled();
                if (cancelled) return;
                setMode(res.enabled ? "qc" : "password");
            } catch {
                if (!cancelled) setMode("password");
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    return (
        <div className="login-wrap">
            <div className="login-card">
                <h1>Jellybean</h1>
                {mode === "loading" && (
                    <p className="muted">Getting things ready…</p>
                )}
                {mode === "qc" && (
                    <QuickConnectView
                        onSuccess={onSuccess}
                        onSwitchToPassword={() => {
                            setError(null);
                            setMode("password");
                        }}
                        onError={setError}
                    />
                )}
                {mode === "password" && (
                    <PasswordView
                        onSuccess={onSuccess}
                        onSwitchToQC={() => {
                            setError(null);
                            setMode("qc");
                        }}
                        onError={setError}
                    />
                )}
                {error && <div className="error">{error}</div>}
            </div>
        </div>
    );
}

function QuickConnectView({
    onSuccess,
    onSwitchToPassword,
    onError,
}: {
    onSuccess: (u: User) => void;
    onSwitchToPassword: () => void;
    onError: (msg: string | null) => void;
}) {
    const [start, setStart] = useState<{
        id: string;
        code: string;
    } | null>(null);
    const [expired, setExpired] = useState(false);
    const startedRef = useRef(false);

    // Tracks the most recent /start call. Set true when a pairing
    // is in-flight or already minted; flipped back to false on
    // error so the user can retry. The "Get a new code" handler
    // also resets it.
    //
    // unmountedRef gates the /start fetch's late callbacks: when
    // the user flips to password mid-fetch, the QC view unmounts
    // and we must not call onError or setStart afterward (the
    // password card will already be mounted by then). This is the
    // analog of the cancelled-flag pattern used in the poll effect
    // below, scoped to the component's lifetime instead of one
    // useEffect run.
    const unmountedRef = useRef(false);
    useEffect(() => {
        return () => {
            unmountedRef.current = true;
        };
    }, []);

    async function startPairing() {
        setExpired(false);
        onError(null);
        try {
            const res = await api.quickConnectStart();
            if (unmountedRef.current) return;
            setStart({ id: res.id, code: res.code });
        } catch (err) {
            if (unmountedRef.current) return;
            startedRef.current = false;
            onError(
                err instanceof HttpError
                    ? `Quick Connect unavailable (${err.status}).`
                    : "Couldn't reach the server.",
            );
        }
    }

    // First-mount: kick a single pairing. The synchronous flip of
    // startedRef BEFORE the await is what makes this StrictMode-safe;
    // the second invocation of this effect sees true and bails. If
    // you flip the order, dev will mint two codes per page load.
    useEffect(() => {
        if (startedRef.current || start) return;
        startedRef.current = true;
        void startPairing();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (!start) return;
        let cancelled = false;
        const tick = async () => {
            try {
                const res = await api.quickConnectPoll(start.id);
                if (cancelled) return;
                if (res.status === "expired") {
                    setExpired(true);
                    setStart(null);
                    startedRef.current = false;
                    return;
                }
                if (res.status === "authorized" && res.user) {
                    onSuccess(res.user);
                }
            } catch (err) {
                if (cancelled) return;
                if (err instanceof HttpError && err.status === 410) {
                    setExpired(true);
                    setStart(null);
                    startedRef.current = false;
                    return;
                }
                if (err instanceof HttpError && err.status === 403) {
                    onError("Admin role required.");
                    setStart(null);
                    startedRef.current = false;
                    return;
                }
                // Transient: next tick will retry.
            }
        };
        const id = window.setInterval(tick, POLL_INTERVAL_MS);
        void tick();
        return () => {
            cancelled = true;
            window.clearInterval(id);
        };
    }, [start, onError, onSuccess]);

    if (expired) {
        return (
            <>
                <p className="muted">
                    That code timed out. Get a fresh one to try again.
                </p>
                <button
                    type="button"
                    className="primary"
                    onClick={() => void startPairing()}
                >
                    Get a new code
                </button>
                <button
                    type="button"
                    className="link-btn"
                    onClick={onSwitchToPassword}
                >
                    Use password instead
                </button>
            </>
        );
    }
    if (!start) {
        return <p className="muted">Starting Quick Connect…</p>;
    }
    return (
        <>
            <p className="muted">
                On any Jellyfin client you're signed into, open your user
                menu and choose <strong>Quick Connect</strong>. Enter the
                code below.
            </p>
            <div className="qc-code" aria-live="polite">
                {start.code.split("").map((d, i) => (
                    <span key={i} className="qc-digit">
                        {d}
                    </span>
                ))}
            </div>
            <p className="qc-status">
                <span className="qc-spinner" aria-hidden />
                Waiting for approval…
            </p>
            <button
                type="button"
                className="link-btn"
                onClick={onSwitchToPassword}
            >
                Use password instead
            </button>
        </>
    );
}

function PasswordView({
    onSuccess,
    onSwitchToQC,
    onError,
}: {
    onSuccess: (u: User) => void;
    onSwitchToQC: () => void;
    onError: (msg: string | null) => void;
}) {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [submitting, setSubmitting] = useState(false);

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        onError(null);
        setSubmitting(true);
        try {
            const user = await api.login(username, password);
            onSuccess(user);
        } catch (err) {
            if (err instanceof HttpError) {
                if (err.status === 401) onError("Invalid credentials.");
                else if (err.status === 403)
                    onError("Admin role required.");
                else if (err.status === 429)
                    onError(
                        "Too many attempts. Try again in a few minutes.",
                    );
                else onError(err.message || "Login failed.");
            } else {
                onError("Network error.");
            }
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <form onSubmit={handleSubmit}>
            <p className="muted">Sign in with your Jellyfin admin account.</p>
            <label>
                Username
                <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoFocus
                    autoComplete="username"
                    required
                />
            </label>
            <label>
                Password
                <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    required
                />
            </label>
            <button
                type="submit"
                className="primary"
                disabled={submitting}
            >
                {submitting ? "Signing in..." : "Sign in"}
            </button>
            <button
                type="button"
                className="link-btn"
                onClick={onSwitchToQC}
            >
                Use Quick Connect instead
            </button>
        </form>
    );
}
