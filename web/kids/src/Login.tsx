import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type FormEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, DeviceMobile, KeyReturn } from "@phosphor-icons/react";
import { clearSession, getSession, setSession, type Session } from "./auth";
import { prefetchLibrary } from "./prefetch";
import {
    QuickConnectError,
    useQuickConnect,
    type QCStartResponse,
} from "./useQuickConnect";

// consumeDevCreds reads dev_user / dev_pass from window.location.hash
// when the activity was launched with the DEV_LOGIN intent
// (see MainActivity.handleDevIntent). Side effects on success: wipe
// any existing session so Login's signed-in redirect doesn't bounce
// us to /browse before we get to fill the form, and strip the hash
// off the URL so the creds don't linger in WebView history. Idempotent
// on its own - calling again after a successful consume sees no hash
// and returns null.
function consumeDevCreds(): { user: string; pass: string } | null {
    if (typeof window === "undefined") return null;
    const raw = window.location.hash.replace(/^#/, "");
    if (!raw) return null;
    const params = new URLSearchParams(raw);
    const user = params.get("dev_user");
    const pass = params.get("dev_pass");
    if (!user || !pass) return null;
    clearSession();
    history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
    );
    return { user, pass };
}

// Login (kid TV). Two paths:
//
// 1. Quick Connect (default when the upstream Jellyfin admin has it
//    enabled): the TV displays a 6-digit code; the parent enters it
//    on a Jellyfin client they're already signed into (phone, web,
//    laptop). The TV polls our backend; the backend forwards each
//    poll to Jellyfin and exchanges the secret for a real bearer
//    once approval lands.
//
// 2. Password fallback: same form as before, kept available even
//    when QC is enabled (some users prefer it; some Jellyfin
//    deployments leave QC off).
//
// Both paths converge on the same /api/kids/auth/login response
// shape, so the post-login hydration is identical.

type LoginResponse = {
    token: string;
    userId: string;
    userName: string;
    kidId?: number;
    kidName?: string;
    profileId: number;
    profileName?: string;
};

type QCPollResponse = {
    status: "pending" | "authorized" | "expired";
    kid?: LoginResponse;
};

// Fetchers normalize the kid app's /api/kids/auth/quickconnect/* shapes
// into the QuickConnectError vocabulary the shared hook speaks.
const qcFetchers = {
    enabled: async () => {
        const res = await fetch("/api/kids/auth/quickconnect/enabled", {
            credentials: "same-origin",
        });
        if (!res.ok) {
            throw new QuickConnectError(
                "unavailable",
                `enabled probe ${res.status}`,
            );
        }
        return (await res.json()) as { enabled: boolean };
    },
    start: async (): Promise<QCStartResponse> => {
        const res = await fetch("/api/kids/auth/quickconnect/start", {
            method: "POST",
            credentials: "same-origin",
        });
        if (!res.ok) {
            throw new QuickConnectError(
                "unavailable",
                `start ${res.status}`,
            );
        }
        return (await res.json()) as QCStartResponse;
    },
    poll: async (id: string): Promise<QCPollResponse> => {
        const res = await fetch(
            `/api/kids/auth/quickconnect/poll?id=${encodeURIComponent(id)}`,
            { credentials: "same-origin" },
        );
        if (res.status === 410 || res.status === 404) {
            throw new QuickConnectError("expired");
        }
        if (res.status === 403) {
            throw new QuickConnectError("forbidden");
        }
        if (!res.ok) {
            throw new QuickConnectError("transient", `poll ${res.status}`);
        }
        return (await res.json()) as QCPollResponse;
    },
};

export default function Login() {
    const nav = useNavigate();
    useEffect(() => {
        window.dispatchEvent(new Event("jellybean:ready"));
    }, []);

    // DEV_LOGIN auto-submit path. Same as before - the dev-launcher
    // intent injects creds via URL hash so we can short-circuit the
    // form during local iteration.
    const [devCreds, setDevCreds] = useState(consumeDevCreds);
    const [username, setUsername] = useState(devCreds?.user ?? "");
    const [password, setPassword] = useState(devCreds?.pass ?? "");
    const [submitError, setSubmitError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        if (getSession()) nav("/browse", { replace: true });
    }, [nav]);

    // completeLogin mints the local session from a /login or /poll
    // success payload and bounces to /browse. Shared by the password
    // submit + the QC poll's authorized branch so both paths land
    // identically.
    const completeLogin = useCallback(
        (kid: LoginResponse) => {
            const session: Session = {
                token: kid.token,
                userId: kid.userId,
                userName: kid.userName,
                profileId: kid.profileId,
                profileName: kid.profileName,
                kidName: kid.kidName,
                kidId: kid.kidId,
            };
            setSession(session);
            prefetchLibrary();
            nav("/browse", { replace: true });
        },
        [nav],
    );

    const qc = useQuickConnect<QCPollResponse, LoginResponse>({
        fetchers: qcFetchers,
        onAuthorized: completeLogin,
        pickResult: (poll) =>
            poll.status === "authorized" && poll.kid ? poll.kid : null,
        terminalFromPoll: (poll) =>
            poll.status === "expired" ? "expired" : null,
        forbiddenMessage:
            "This Jellyfin user isn't set up as a kid in Jellybean. Ask a parent to add you in the admin app.",
        unavailableMessage: () =>
            "Couldn't start Quick Connect. Use password instead.",
        skip: !!devCreds,
    });

    // Original kid behavior dropped to password mode on /start failure
    // so the user could still sign in. Preserve that by watching the
    // hook's error and flipping mode when an unavailable fires; the
    // hook leaves the error visible (setMode does NOT clear it), so
    // the kid sees the explanation on the password card.
    useEffect(() => {
        if (qc.error && qc.mode === "qc") {
            qc.setMode("password");
        }
    }, [qc.error, qc.mode, qc]);

    const performLogin = useCallback(
        async (rawUser: string, rawPass: string) => {
            const u = rawUser.trim();
            const p = rawPass;
            if (!u || !p) {
                setSubmitError("Username and password are required.");
                return;
            }
            setSubmitting(true);
            setSubmitError(null);
            try {
                const res = await fetch("/api/kids/auth/login", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    credentials: "same-origin",
                    body: JSON.stringify({ username: u, password: p }),
                });
                if (res.status === 401) {
                    setSubmitError("Wrong username or password.");
                    return;
                }
                if (res.status === 403) {
                    setSubmitError(
                        "This Jellyfin user isn't set up as a kid in Jellybean. Ask a parent to add you in the admin app.",
                    );
                    return;
                }
                if (res.status === 502) {
                    setSubmitError("Couldn't reach Jellyfin. Try again.");
                    return;
                }
                if (!res.ok) {
                    setSubmitError(`Sign-in failed (${res.status}).`);
                    return;
                }
                completeLogin((await res.json()) as LoginResponse);
            } catch {
                setSubmitError("Couldn't reach the server. Try again.");
            } finally {
                setSubmitting(false);
            }
        },
        [completeLogin],
    );

    // DEV_LOGIN auto-submit fires once the form is mounted.
    useEffect(() => {
        if (!devCreds) return;
        if (submitting) return;
        setUsername(devCreds.user);
        setPassword(devCreds.pass);
        void performLogin(devCreds.user, devCreds.pass);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [devCreds, performLogin]);

    // Warm-start dev creds (intent fires while Login is already
    // mounted - hashchange but no remount).
    useEffect(() => {
        const onHashChange = () => {
            const fresh = consumeDevCreds();
            if (fresh) setDevCreds(fresh);
        };
        window.addEventListener("hashchange", onHashChange);
        return () => window.removeEventListener("hashchange", onHashChange);
    }, []);

    async function onSubmit(e: FormEvent) {
        e.preventDefault();
        if (submitting) return;
        await performLogin(username, password);
    }

    const error = submitError ?? qc.error;

    return (
        <div className="kid-login">
            <img
                src="/player/jellybean-kids.png"
                alt="Jellybean Kids"
                className="kid-login-brand"
                width={96}
                height={96}
            />
            <h1>Sign in</h1>
            {qc.mode === "loading" && (
                <p className="kid-login-blurb">Getting things ready…</p>
            )}
            {qc.mode === "qc" && (
                <QCCard
                    code={qc.code}
                    expired={qc.expired}
                    onRetry={qc.restart}
                    onSwitchToPassword={() => {
                        setSubmitError(null);
                        qc.setError(null);
                        qc.setMode("password");
                    }}
                />
            )}
            {qc.mode === "password" && (
                <PasswordCard
                    username={username}
                    password={password}
                    submitting={submitting}
                    onUsername={setUsername}
                    onPassword={setPassword}
                    onSubmit={onSubmit}
                    showQCBack={!qc.error}
                    onSwitchToQC={() => {
                        setSubmitError(null);
                        qc.setError(null);
                        qc.setMode("qc");
                    }}
                />
            )}
            {error && <p className="kid-login-error">{error}</p>}
        </div>
    );
}

// QCCard: shows the 6-digit code + a "go to your phone" instruction.
// Big monospace digits so a kid (or a parent leaning back on the
// couch) can read them from across the room. The "Use password
// instead" footer is the secondary affordance, focusable for D-pad.
function QCCard({
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
    const switchRef = useRef<HTMLButtonElement | null>(null);
    const retryRef = useRef<HTMLButtonElement | null>(null);
    useEffect(() => {
        // Default focus on the secondary action. The code itself is
        // info-only; nothing for the kid to do on this view except
        // wait or switch to password.
        if (expired) retryRef.current?.focus();
        else switchRef.current?.focus();
    }, [expired]);
    return (
        <div className="kid-login-card">
            <div className="kid-login-card-icon" aria-hidden>
                <DeviceMobile size={28} weight="fill" />
            </div>
            <h2>Quick Connect</h2>
            {expired ? (
                <>
                    <p className="kid-login-blurb">
                        That code timed out. Get a fresh one to try again.
                    </p>
                    <button
                        ref={retryRef}
                        type="button"
                        className="kid-login-primary"
                        onClick={onRetry}
                    >
                        Get a new code
                    </button>
                </>
            ) : (
                <>
                    <p className="kid-login-blurb">
                        On your phone or computer, sign in to Jellyfin, open
                        your user menu, and choose Quick Connect. Type the
                        code below.
                    </p>
                    <div className="kid-login-code" aria-live="polite">
                        {code ? (
                            code.split("").map((d, i) => (
                                <span key={i} className="kid-login-code-digit">
                                    {d}
                                </span>
                            ))
                        ) : (
                            <span className="kid-login-code-loading">…</span>
                        )}
                    </div>
                    <p className="kid-login-status">
                        <span className="kid-login-spinner" aria-hidden />
                        Waiting for approval…
                    </p>
                </>
            )}
            <button
                ref={switchRef}
                type="button"
                className="kid-login-link"
                onClick={onSwitchToPassword}
            >
                <KeyReturn size={16} weight="bold" aria-hidden /> Use password
                instead
            </button>
        </div>
    );
}

// PasswordCard: the original username + password form, with the
// "Use Quick Connect" link as a secondary affordance when QC is
// available. autoFocus on the username input so the kid (or
// parent leaning over with their phone keyboard) can start typing
// immediately.
function PasswordCard({
    username,
    password,
    submitting,
    onUsername,
    onPassword,
    onSubmit,
    showQCBack,
    onSwitchToQC,
}: {
    username: string;
    password: string;
    submitting: boolean;
    onUsername: (v: string) => void;
    onPassword: (v: string) => void;
    onSubmit: (e: FormEvent) => void;
    showQCBack: boolean;
    onSwitchToQC: () => void;
}) {
    return (
        <div className="kid-login-card">
            <h2>Username + password</h2>
            <p className="kid-login-blurb">
                Sign in with your Jellyfin account. A parent needs to set you
                up in Jellybean first.
            </p>
            <form onSubmit={onSubmit} className="kid-login-form">
                <label>
                    Username
                    <input
                        autoFocus
                        autoComplete="username"
                        value={username}
                        onChange={(e) => onUsername(e.target.value)}
                    />
                </label>
                <label>
                    Password
                    <input
                        type="password"
                        autoComplete="current-password"
                        value={password}
                        onChange={(e) => onPassword(e.target.value)}
                    />
                </label>
                <button
                    type="submit"
                    className="kid-login-primary"
                    disabled={submitting}
                >
                    {submitting ? "Signing in…" : "Sign in"}
                </button>
            </form>
            {showQCBack && (
                <button
                    type="button"
                    className="kid-login-link"
                    onClick={onSwitchToQC}
                >
                    <ArrowLeft size={16} weight="bold" aria-hidden /> Use Quick
                    Connect instead
                </button>
            )}
        </div>
    );
}
