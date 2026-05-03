import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { getSession, setSession, type Session } from "./auth";

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
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);

    // If the user is already signed in, skip the login screen. This
    // mirrors the Index redirect but covers the case of a user manually
    // navigating to /login while a token is in storage.
    useEffect(() => {
        if (getSession()) nav("/library", { replace: true });
    }, [nav]);

    async function onSubmit(e: FormEvent) {
        e.preventDefault();
        if (submitting) return;
        const u = username.trim();
        const p = password;
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
            nav("/library", { replace: true });
        } catch {
            setError("Couldn't reach the server. Try again.");
        } finally {
            setSubmitting(false);
        }
    }

    const serverUrl = window.location.origin;

    return (
        <div className="setup">
            <img
                src="/kids/jellybean-kids.png"
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
