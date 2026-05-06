import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { clearSession, getSession, setSession, type Session } from "./auth";
import { prefetchLibrary } from "./prefetch";

// consumeDevCreds reads dev_user / dev_pass from window.location.hash
// when the activity was launched with the DEV_LOGIN intent
// (see MainActivity.handleDevIntent). Side effects on success: wipe
// any existing session so Login's signed-in redirect doesn't bounce
// us to /browse before we get to fill the form, and strip the hash
// off the URL so the creds don't linger in WebView history. Idempotent
// on its own - calling again after a successful consume sees no hash
// and returns null. Required to support both cold-start (hash present
// at first mount) AND warm-start (Login already mounted, hash arrives
// via webView.loadUrl staying on the same path).
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

// Login is the kid app's entry point. Same UX as Jellyfin's own clients:
// server URL (auto-filled and read-only here, since the kid app is served
// from the same origin as Jellybean), Jellyfin username, Jellyfin password.
// On submit we POST to /api/kids/auth/login; the backend forwards to
// Jellyfin's AuthenticateByName, looks up the kid mapping, and returns a
// Session payload we persist in localStorage.

type LoginResponse = {
    token: string;
    userId: string;
    userName: string;
    kidId?: number;
    kidName?: string;
    profileId: number;
    profileName?: string;
};

export default function Login() {
    const nav = useNavigate();
    // Lazy initializer reads (and consumes) the DEV_LOGIN hash creds
    // on first mount. clearSession runs synchronously inside so the
    // signed-in redirect below sees null. Updated below on hashchange
    // for the warm-start case where Login is already mounted when the
    // intent fires.
    const [devCreds, setDevCreds] = useState(consumeDevCreds);
    const [username, setUsername] = useState(devCreds?.user ?? "");
    const [password, setPassword] = useState(devCreds?.pass ?? "");
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);

    // If the user is already signed in, skip the login screen. This
    // mirrors the Index redirect but covers the case of a user manually
    // navigating to /login while a token is in storage.
    useEffect(() => {
        if (getSession()) nav("/browse", { replace: true });
    }, [nav]);

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

    // DEV_LOGIN auto-submit. When the activity was launched with creds
    // in the hash, fire the login as soon as the form has rendered.
    // Also reflects the values into the form's controlled inputs so
    // the kid sees what's about to submit.
    useEffect(() => {
        if (!devCreds) return;
        if (submitting) return;
        setUsername(devCreds.user);
        setPassword(devCreds.pass);
        void performLogin(devCreds.user, devCreds.pass);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [devCreds, performLogin]);

    // Warm-start: the activity is already running on /player/login
    // when the DEV_LOGIN intent fires. webView.loadUrl(targetUrl)
    // stays on the same path and only updates the hash, so React
    // Router doesn't remount Login - we wouldn't see the new creds
    // without a hashchange listener.
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

    const serverUrl = window.location.origin;

    return (
        <div className="setup">
            <img
                src="/player/jellybean-kids.png"
                alt="Jellybean Kids"
                className="picker-brand"
                width={96}
                height={96}
            />
            <h1>Sign in</h1>
            <p>
                Sign in with your Jellyfin username and password. A parent
                needs to set you up in Jellybean first.
            </p>

            <form onSubmit={onSubmit}>
                <label>
                    Server
                    <input value={serverUrl} readOnly />
                </label>
                <label>
                    Username
                    <input
                        autoFocus
                        autoComplete="username"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                    />
                </label>
                <label>
                    Password
                    <input
                        type="password"
                        autoComplete="current-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                    />
                </label>
                {error && <p className="error">{error}</p>}
                <button type="submit" disabled={submitting}>
                    {submitting ? "Signing in..." : "Sign in"}
                </button>
            </form>
        </div>
    );
}
