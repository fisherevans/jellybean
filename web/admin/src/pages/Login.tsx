import { useState } from "react";
import { api, HttpError, type User } from "../api";

type Props = {
    onSuccess: (u: User) => void;
};

export default function Login({ onSuccess }: Props) {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        setError(null);
        setSubmitting(true);
        try {
            const user = await api.login(username, password);
            onSuccess(user);
        } catch (err) {
            if (err instanceof HttpError) {
                if (err.status === 401) setError("Invalid credentials.");
                else if (err.status === 403) setError("Admin role required.");
                else if (err.status === 429) setError("Too many attempts. Try again in a few minutes.");
                else setError(err.message || "Login failed.");
            } else {
                setError("Network error.");
            }
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <div className="login-wrap">
            <form className="login-card" onSubmit={handleSubmit}>
                <h1>Jellybean</h1>
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
                {error && <div className="error">{error}</div>}
                <button
                    type="submit"
                    className="primary"
                    disabled={submitting}
                >
                    {submitting ? "Signing in..." : "Sign in"}
                </button>
            </form>
        </div>
    );
}
