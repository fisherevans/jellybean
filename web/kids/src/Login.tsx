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

const POLL_INTERVAL_MS = 3000;

type LoginResponse = {
    token: string;
    userId: string;
    userName: string;
    kidId?: number;
    kidName?: string;
    profileId: number;
    profileName?: string;
};

type QCStartResponse = {
    id: string;
    code: string;
    expiresAt: string;
};

type QCPollResponse = {
    status: "pending" | "authorized" | "expired";
    kid?: LoginResponse;
};

type Mode = "loading" | "qc" | "password";

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
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);

    // Mode: which card the kid TV currently shows. Starts "loading"
    // while we probe whether QC is enabled on the upstream Jellyfin;
    // settles to "qc" or "password" within ~one round trip.
    const [mode, setMode] = useState<Mode>("loading");
    const [qcStart, setQCStart] = useState<QCStartResponse | null>(null);
    const [qcExpired, setQCExpired] = useState(false);

    useEffect(() => {
        if (getSession()) nav("/browse", { replace: true });
    }, [nav]);

    // Probe QC support. We default to QC when the server advertises
    // it (saves password typing on a TV remote). Failures fall to
    // password automatically; nothing to surface to the user.
    useEffect(() => {
        if (devCreds) return; // dev path skips both modes
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(
                    "/api/kids/auth/quickconnect/enabled",
                    { credentials: "same-origin" },
                );
                if (cancelled) return;
                if (res.ok) {
                    const body = (await res.json()) as { enabled: boolean };
                    setMode(body.enabled ? "qc" : "password");
                    return;
                }
            } catch {
                /* fall through */
            }
            if (!cancelled) setMode("password");
        })();
        return () => {
            cancelled = true;
        };
    }, [devCreds]);

    // Start a QC pairing whenever we enter qc mode and don't already
    // have one. handles "code expired" by re-running with reset.
    const startQC = useCallback(async () => {
        setError(null);
        setQCExpired(false);
        try {
            const res = await fetch("/api/kids/auth/quickconnect/start", {
                method: "POST",
                credentials: "same-origin",
            });
            if (!res.ok) {
                setError("Couldn't start Quick Connect. Use password instead.");
                setMode("password");
                return;
            }
            const body = (await res.json()) as QCStartResponse;
            setQCStart(body);
        } catch {
            setError("Couldn't reach the server.");
            setMode("password");
        }
    }, []);

    useEffect(() => {
        if (mode !== "qc" || qcStart || qcExpired) return;
        void startQC();
    }, [mode, qcStart, qcExpired, startQC]);

    // Poll the QC pairing. Stops on terminal state. POLL_INTERVAL_MS
    // matches Jellyfin web's own cadence; the backend caches the
    // exchange result so a duplicate poll between approval and
    // navigation is safe.
    useEffect(() => {
        if (mode !== "qc" || !qcStart) return;
        let cancelled = false;
        const tick = async () => {
            try {
                const res = await fetch(
                    `/api/kids/auth/quickconnect/poll?id=${encodeURIComponent(qcStart.id)}`,
                    { credentials: "same-origin" },
                );
                if (cancelled) return;
                if (res.status === 410 || res.status === 404) {
                    setQCExpired(true);
                    setQCStart(null);
                    return;
                }
                if (res.status === 403) {
                    setError(
                        "This Jellyfin user isn't set up as a kid in Jellybean. Ask a parent to add you in the admin app.",
                    );
                    setQCExpired(true);
                    setQCStart(null);
                    return;
                }
                if (!res.ok) return; // transient; next tick retries
                const body = (await res.json()) as QCPollResponse;
                if (body.status === "expired") {
                    setQCExpired(true);
                    setQCStart(null);
                    return;
                }
                if (body.status === "authorized" && body.kid) {
                    const session: Session = {
                        token: body.kid.token,
                        userId: body.kid.userId,
                        userName: body.kid.userName,
                        profileId: body.kid.profileId,
                        profileName: body.kid.profileName,
                        kidName: body.kid.kidName,
                        kidId: body.kid.kidId,
                    };
                    setSession(session);
                    prefetchLibrary();
                    nav("/browse", { replace: true });
                }
            } catch {
                /* transient; next tick retries */
            }
        };
        const id = window.setInterval(tick, POLL_INTERVAL_MS);
        // Fire one immediately so a user who happened to approve
        // before the poll loop kicked in doesn't sit through a
        // full interval of "Waiting..."
        void tick();
        return () => {
            cancelled = true;
            window.clearInterval(id);
        };
    }, [mode, qcStart, nav]);

    const performLogin = useCallback(
        async (rawUser: string, rawPass: string) => {
            const u = rawUser.trim();
            const p = rawPass;
            if (!u || !p) {
                setError("Username and password are required.");
                return;
            }
            setSubmitting(true);
            setError(null);
            try {
                const res = await fetch("/api/kids/auth/login", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    credentials: "same-origin",
                    body: JSON.stringify({ username: u, password: p }),
                });
                if (res.status === 401) {
                    setError("Wrong username or password.");
                    return;
                }
                if (res.status === 403) {
                    setError(
                        "This Jellyfin user isn't set up as a kid in Jellybean. Ask a parent to add you in the admin app.",
                    );
                    return;
                }
                if (res.status === 502) {
                    setError("Couldn't reach Jellyfin. Try again.");
                    return;
                }
                if (!res.ok) {
                    setError(`Sign-in failed (${res.status}).`);
                    return;
                }
                const data = (await res.json()) as LoginResponse;
                const session: Session = {
                    token: data.token,
                    userId: data.userId,
                    userName: data.userName,
                    profileId: data.profileId,
                    profileName: data.profileName,
                    kidName: data.kidName,
                    kidId: data.kidId,
                };
                setSession(session);
                prefetchLibrary();
                nav("/browse", { replace: true });
            } catch {
                setError("Couldn't reach the server. Try again.");
            } finally {
                setSubmitting(false);
            }
        },
        [nav],
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
            {mode === "loading" && (
                <p className="kid-login-blurb">Getting things ready…</p>
            )}
            {mode === "qc" && (
                <QCCard
                    code={qcStart?.code ?? null}
                    expired={qcExpired}
                    onRetry={() => void startQC()}
                    onSwitchToPassword={() => setMode("password")}
                />
            )}
            {mode === "password" && (
                <PasswordCard
                    username={username}
                    password={password}
                    submitting={submitting}
                    onUsername={setUsername}
                    onPassword={setPassword}
                    onSubmit={onSubmit}
                    showQCBack={qcStart !== null || !qcExpired}
                    onSwitchToQC={() => {
                        setError(null);
                        setMode("qc");
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
