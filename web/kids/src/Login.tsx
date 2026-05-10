import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type FormEvent,
    type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import {
    DeviceMobile,
    KeyReturn,
    QrCode,
} from "@phosphor-icons/react";
import { QRCodeSVG } from "qrcode.react";
import type {
    KidLoginResponse,
    PairPollResponse,
    PairStartResponse,
    QuickConnectPollResponse,
} from "jellybean-shared";
import {
    clearSession,
    getSession,
    sessionFromKidPayload,
    setSession,
} from "./auth";
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

// Login (kid TV). Three sign-in surfaces:
//
// 1. Quick Connect (default when the upstream Jellyfin admin has it
//    enabled): the TV displays a 6-digit code; the parent enters it
//    on a Jellyfin client they're already signed into. Requires an
//    existing Jellyfin session somewhere.
//
// 2. Phone pairing (new): the TV displays a QR code linking to
//    /pair/<short_code> on this Jellybean instance. The parent
//    scans it, enters the kid's Jellyfin credentials in their phone
//    browser (password manager friendly), and the TV's poll lifts
//    the resulting Jellyfin auth out of SQLite. Distinct from QC -
//    no existing Jellyfin session needed on the parent's device.
//
// 3. Password fallback: the original form, kept available because
//    not every parent has a phone handy and not every Jellyfin
//    deployment has QC enabled.
//
// All three paths converge on the same KidLoginResponse shape and
// sessionFromKidPayload, so the post-login hydration is identical.

// Shared with the server's kidAuthResponse struct
// (internal/server/quickconnect.go + internal/server/kids.go).
// Kid-side QC poll embeds the same LoginResponse under `kid`.
type LoginResponse = KidLoginResponse;
type QCPollResponse = QuickConnectPollResponse<LoginResponse>;

// PAIR_POLL_INTERVAL_MS is the cadence the TV polls
// /api/kids/auth/pair/poll. Matches Jellyfin's QC poll cadence so
// the spinner feels consistent across login paths.
const PAIR_POLL_INTERVAL_MS = 2500;

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

// Card type drives which sub-card shows on the login screen. The
// existing useQuickConnect hook owns the qc / password split via its
// own Mode; pair is the new third surface this component layers on
// top.
type Card = "loading" | "qc" | "password" | "pair";

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

    // Card-level override for the QC hook's mode. null = follow QC
    // hook (loading / qc / password); set to "pair" when the user
    // taps "Sign in with phone." The hook's mode is left alone so
    // flipping back to QC reuses an in-flight pairing.
    const [overrideCard, setOverrideCard] = useState<Card | null>(null);

    useEffect(() => {
        if (getSession()) nav("/browse", { replace: true });
    }, [nav]);

    // completeLogin mints the local session from a /login or /poll
    // success payload and bounces to /browse. Shared by the password
    // submit + the QC poll's authorized branch + the pair poll's
    // complete branch so all three paths land identically.
    const completeLogin = useCallback(
        (kid: LoginResponse) => {
            setSession(sessionFromKidPayload(kid));
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

    // Effective card: overrideCard wins so "Sign in with phone" pulls
    // the user out of whatever default the QC hook landed on. Cleared
    // when the user backs out of pair mode.
    const card: Card = overrideCard ?? (qc.mode as Card);

    const error = submitError ?? qc.error;

    // Shared mode-switcher factory. Each card calls it with its own
    // autoFocusFirst flag (true when the card has no in-card primary
    // action and the switcher should catch initial D-pad focus). The
    // closure captures the parent's mode-pick callback so all three
    // cards funnel through the same state transitions. QC is omitted
    // from the row when the upstream Jellyfin admin has it disabled
    // (qc.mode locked to password by the unavailable-flip effect).
    const qcAvailable = qc.mode === "qc" || qc.mode === "loading";
    const onPick = (target: "qc" | "password" | "pair") => {
        setSubmitError(null);
        qc.setError(null);
        if (target === "pair") {
            setOverrideCard("pair");
            return;
        }
        setOverrideCard(null);
        qc.setMode(target);
    };
    const renderSwitcher = (autoFocusFirst: boolean) => (
        <ModeSwitcher
            current={card}
            qcAvailable={qcAvailable}
            onPick={onPick}
            autoFocusFirst={autoFocusFirst}
        />
    );

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
            {card === "loading" && (
                <p className="kid-login-blurb">Getting things ready…</p>
            )}
            {card === "qc" && (
                <QCCard
                    code={qc.code}
                    expired={qc.expired}
                    onRetry={qc.restart}
                    renderSwitcher={renderSwitcher}
                />
            )}
            {card === "password" && (
                <PasswordCard
                    username={username}
                    password={password}
                    submitting={submitting}
                    onUsername={setUsername}
                    onPassword={setPassword}
                    onSubmit={onSubmit}
                    renderSwitcher={renderSwitcher}
                />
            )}
            {card === "pair" && (
                <PairCard
                    onAuthorized={completeLogin}
                    renderSwitcher={renderSwitcher}
                />
            )}
            {error && <p className="kid-login-error">{error}</p>}
        </div>
    );
}

// ModeSwitcher renders a 3-pill row at the bottom of each card so
// all three sign-in modes are visible regardless of which card is
// active. The current mode is rendered as a non-focusable label;
// the other two are buttons that swap the card. Single shared
// component so the switcher looks identical from every entry point
// and the kid (or parent) sees the full menu of options at all times.
//
// QC is hidden when qcAvailable is false (the upstream Jellyfin admin
// has Quick Connect disabled, or the /enabled probe failed on boot).
function ModeSwitcher({
    current,
    qcAvailable,
    onPick,
    autoFocusFirst = false,
}: {
    current: Card;
    qcAvailable: boolean;
    onPick: (target: "qc" | "password" | "pair") => void;
    autoFocusFirst?: boolean;
}) {
    const firstLinkRef = useRef<HTMLButtonElement | null>(null);
    useEffect(() => {
        // TV: D-pad needs an anchor element. When the active card has
        // no in-card primary action (QC waiting state, PairCard QR
        // state) the parent passes autoFocusFirst so the kid can pick
        // up from a focused mode button instead of an unfocused page.
        if (autoFocusFirst) firstLinkRef.current?.focus();
    }, [autoFocusFirst]);
    const items: {
        key: "qc" | "password" | "pair";
        label: string;
        icon: ReactNode;
    }[] = [];
    if (qcAvailable) {
        items.push({
            key: "qc",
            label: "Quick Connect",
            icon: <DeviceMobile size={16} weight="bold" aria-hidden />,
        });
    }
    items.push({
        key: "pair",
        label: "Sign in with phone",
        icon: <QrCode size={16} weight="bold" aria-hidden />,
    });
    items.push({
        key: "password",
        label: "Use password",
        icon: <KeyReturn size={16} weight="bold" aria-hidden />,
    });
    let firstLinkAssigned = false;
    return (
        <div className="kid-login-modes" role="group" aria-label="Sign-in options">
            {items.map((it) => {
                const isCurrent = it.key === current;
                if (isCurrent) {
                    return (
                        <span
                            key={it.key}
                            className="kid-login-mode kid-login-mode-current"
                            aria-current="true"
                        >
                            {it.icon} {it.label}
                        </span>
                    );
                }
                const ref = !firstLinkAssigned ? firstLinkRef : undefined;
                if (!firstLinkAssigned) firstLinkAssigned = true;
                return (
                    <button
                        key={it.key}
                        ref={ref}
                        type="button"
                        className="kid-login-mode kid-login-mode-link"
                        onClick={() => onPick(it.key)}
                    >
                        {it.icon} {it.label}
                    </button>
                );
            })}
        </div>
    );
}

// QCCard: shows the 6-digit code + a "go to your phone" instruction.
// Big monospace digits so a kid (or a parent leaning back on the
// couch) can read them from across the room. The mode-switcher row
// at the bottom (rendered by Login) makes the other two sign-in
// surfaces directly reachable.
function QCCard({
    code,
    expired,
    onRetry,
    renderSwitcher,
}: {
    code: string | null;
    expired: boolean;
    onRetry: () => void;
    renderSwitcher: (autoFocusFirst: boolean) => ReactNode;
}) {
    const retryRef = useRef<HTMLButtonElement | null>(null);
    useEffect(() => {
        // Only auto-focus the retry button when the code expired and
        // a primary action exists. In the normal "waiting" state the
        // code itself is info-only; the switcher row catches initial
        // D-pad focus instead (autoFocusFirst below).
        if (expired) retryRef.current?.focus();
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
            {renderSwitcher(!expired)}
        </div>
    );
}

// PasswordCard: the original username + password form. The shared
// mode-switcher row at the bottom (rendered by Login) handles the
// "switch to a different sign-in" affordance. autoFocus on the
// username input so the kid (or parent leaning over with their
// phone keyboard) can start typing immediately.
function PasswordCard({
    username,
    password,
    submitting,
    onUsername,
    onPassword,
    onSubmit,
    renderSwitcher,
}: {
    username: string;
    password: string;
    submitting: boolean;
    onUsername: (v: string) => void;
    onPassword: (v: string) => void;
    onSubmit: (e: FormEvent) => void;
    renderSwitcher: (autoFocusFirst: boolean) => ReactNode;
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
            {/* Username input owns initial focus via autoFocus, so the
                switcher should NOT steal it. */}
            {renderSwitcher(false)}
        </div>
    );
}

// PairCard owns the phone-pairing handshake. Kicks /pair/start on
// mount, renders the QR + short code, and polls /pair/poll on a
// 2.5s cadence. On poll status=complete, hands the kid payload to
// onAuthorized. On expired, shows a retry button. On 4xx during
// /start, falls back to "couldn't start" with manual retry.
//
// StrictMode-safe via startedRef (synchronous flip BEFORE the await
// matches useQuickConnect's pattern).
function PairCard({
    onAuthorized,
    renderSwitcher,
}: {
    onAuthorized: (kid: LoginResponse) => void;
    renderSwitcher: (autoFocusFirst: boolean) => ReactNode;
}) {
    const [start, setStart] = useState<PairStartResponse | null>(null);
    const [expired, setExpired] = useState(false);
    const [pairError, setPairError] = useState<string | null>(null);
    const startedRef = useRef(false);
    const unmountedRef = useRef(false);
    const onAuthorizedRef = useRef(onAuthorized);
    useEffect(() => {
        onAuthorizedRef.current = onAuthorized;
    }, [onAuthorized]);
    useEffect(() => {
        return () => {
            unmountedRef.current = true;
        };
    }, []);

    const beginPair = useCallback(async () => {
        setExpired(false);
        setPairError(null);
        try {
            const res = await fetch("/api/kids/auth/pair/start", {
                method: "POST",
                credentials: "same-origin",
            });
            if (!res.ok) {
                throw new Error(`pair start ${res.status}`);
            }
            const body = (await res.json()) as PairStartResponse;
            if (unmountedRef.current) return;
            setStart(body);
        } catch {
            if (unmountedRef.current) return;
            startedRef.current = false;
            setPairError(
                "Couldn't start phone sign-in. Use password instead.",
            );
        }
    }, []);

    // Mint a pairing on first mount. The synchronous startedRef flip
    // BEFORE the await is what makes this StrictMode-safe; the
    // double-mount in dev sees true and bails.
    useEffect(() => {
        if (start || expired) return;
        if (startedRef.current) return;
        startedRef.current = true;
        void beginPair();
    }, [start, expired, beginPair]);

    // Poll while a pairing is live. Stops on terminal state
    // (complete -> onAuthorized, expired -> render retry). Fires
    // one tick immediately so a quick parent who completes before
    // the first interval doesn't sit through 2.5s of "Waiting…".
    useEffect(() => {
        if (!start || expired) return;
        let cancelled = false;
        const tick = async () => {
            try {
                const res = await fetch(
                    `/api/kids/auth/pair/poll?token=${encodeURIComponent(start.pollingToken)}`,
                    { credentials: "same-origin" },
                );
                if (cancelled) return;
                if (!res.ok) return; // transient; next tick retries
                const body = (await res.json()) as PairPollResponse;
                if (body.status === "expired") {
                    setExpired(true);
                    setStart(null);
                    startedRef.current = false;
                    return;
                }
                if (body.status === "complete" && body.kid) {
                    onAuthorizedRef.current(body.kid);
                }
            } catch {
                // Transient: next tick retries.
            }
        };
        const id = window.setInterval(tick, PAIR_POLL_INTERVAL_MS);
        void tick();
        return () => {
            cancelled = true;
            window.clearInterval(id);
        };
    }, [start, expired]);

    const restart = useCallback(() => {
        setExpired(false);
        setStart(null);
        startedRef.current = false;
        void beginPair();
    }, [beginPair]);

    const retryRef = useRef<HTMLButtonElement | null>(null);
    useEffect(() => {
        // Focus the retry primary when we're in an error / expired
        // state. In the live-QR state there's no in-card primary - the
        // mode-switcher row at the bottom catches initial focus.
        if (expired || pairError) retryRef.current?.focus();
    }, [expired, pairError]);

    return (
        <div className="kid-login-card">
            <div className="kid-login-card-icon" aria-hidden>
                <QrCode size={28} weight="fill" />
            </div>
            <h2>Sign in with phone</h2>
            {pairError ? (
                <>
                    <p className="kid-login-blurb">{pairError}</p>
                    <button
                        ref={retryRef}
                        type="button"
                        className="kid-login-primary"
                        onClick={restart}
                    >
                        Try again
                    </button>
                </>
            ) : expired ? (
                <>
                    <p className="kid-login-blurb">
                        That code timed out. Get a fresh one to try again.
                    </p>
                    <button
                        ref={retryRef}
                        type="button"
                        className="kid-login-primary"
                        onClick={restart}
                    >
                        Get a new code
                    </button>
                </>
            ) : start ? (
                <>
                    <p className="kid-login-blurb">
                        Scan the code below with your phone, then enter the
                        kid's Jellyfin login.
                    </p>
                    <div className="kid-login-qr" aria-hidden={false}>
                        <QRCodeSVG
                            value={start.pairUrl}
                            size={220}
                            includeMargin
                            level="M"
                        />
                    </div>
                    <p className="kid-login-pair-code">
                        Or visit:{" "}
                        <code className="kid-login-pair-url">
                            {start.pairUrl}
                        </code>
                    </p>
                    <p className="kid-login-status">
                        <span className="kid-login-spinner" aria-hidden />
                        Waiting for sign-in…
                    </p>
                </>
            ) : (
                <p className="kid-login-blurb">Generating a code…</p>
            )}
            {/* Switcher catches initial focus only when there's no
                in-card primary (live-QR / generating states). The
                pairError + expired branches focus retryRef instead. */}
            {renderSwitcher(!expired && !pairError)}
        </div>
    );
}
