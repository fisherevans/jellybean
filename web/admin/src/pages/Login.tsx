import { useCallback, useState } from "react";
import { api, HttpError, type User } from "../api";
import {
    QuickConnectError,
    useQuickConnect,
    type QCStartResponse,
} from "../useQuickConnect";

// Admin login. Two paths:
//
// 1. Quick Connect (default when the upstream Jellyfin admin has it
//    enabled): the admin enters the 6-digit code on a Jellyfin client
//    they're already signed into. Server polls Jellyfin every ~3s and
//    mints our session cookie when approval lands. Same cadence as
//    the kid TV path.
//
// 2. Username/password (always available): same form as before.

type Props = {
    onSuccess: (u: User) => void;
};

type AdminQCPollResponse = {
    status: "pending" | "authorized" | "expired";
    user?: User;
};

// Fetchers normalize the admin app's HttpError surface into the
// QuickConnectError vocabulary the shared hook speaks.
const qcFetchers = {
    enabled: () => api.quickConnectEnabled(),
    start: async (): Promise<QCStartResponse> => api.quickConnectStart(),
    poll: async (id: string): Promise<AdminQCPollResponse> => {
        try {
            return await api.quickConnectPoll(id);
        } catch (err) {
            if (err instanceof HttpError) {
                if (err.status === 410 || err.status === 404) {
                    throw new QuickConnectError("expired");
                }
                if (err.status === 403) {
                    throw new QuickConnectError("forbidden");
                }
            }
            throw new QuickConnectError("transient", String(err));
        }
    },
};

export default function Login({ onSuccess }: Props) {
    const qc = useQuickConnect<AdminQCPollResponse, User>({
        fetchers: qcFetchers,
        onAuthorized: onSuccess,
        pickResult: (poll) =>
            poll.status === "authorized" && poll.user ? poll.user : null,
        terminalFromPoll: (poll) =>
            poll.status === "expired" ? "expired" : null,
        forbiddenMessage: "Admin role required.",
        unavailableMessage: (err) =>
            err instanceof HttpError
                ? `Quick Connect unavailable (${err.status}).`
                : "Couldn't reach the server.",
    });

    return (
        <div className="login-wrap">
            <div className="login-card">
                <h1>Jellybean</h1>
                {qc.mode === "loading" && (
                    <p className="muted">Getting things ready…</p>
                )}
                {qc.mode === "qc" && (
                    <QuickConnectView
                        code={qc.code}
                        expired={qc.expired}
                        onRetry={qc.restart}
                        onSwitchToPassword={() => {
                            qc.setError(null);
                            qc.setMode("password");
                        }}
                    />
                )}
                {qc.mode === "password" && (
                    <PasswordView
                        onSuccess={onSuccess}
                        onSwitchToQC={() => {
                            qc.setError(null);
                            qc.setMode("qc");
                        }}
                        onError={qc.setError}
                    />
                )}
                {qc.error && <div className="error">{qc.error}</div>}
            </div>
        </div>
    );
}

function QuickConnectView({
    code,
    expired,
    onRetry,
    onSwitchToPassword,
}: {
    code: string | null;
    expired: boolean;
    onRetry: () => void;
    onSwitchToPassword: () => void;
}) {
    if (expired) {
        return (
            <>
                <p className="muted">
                    That code timed out. Get a fresh one to try again.
                </p>
                <button
                    type="button"
                    className="primary"
                    onClick={onRetry}
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
    if (!code) {
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
                {code.split("").map((d, i) => (
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

    const handleSubmit = useCallback(
        async (e: React.FormEvent) => {
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
        },
        [username, password, onSuccess, onError],
    );

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
