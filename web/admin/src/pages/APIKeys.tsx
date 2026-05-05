import { useEffect, useState } from "react";
import {
    api,
    HttpError,
    type APIAccessLogEntry,
    type APIKey,
} from "../api";
import Spinner from "../Spinner";

// API keys admin (M14 #90). Three sections:
//   - Create new key (name input + button; modal-style reveal of the
//     plaintext token after creation).
//   - List of existing keys with last-used + revoked status; revoke
//     and delete buttons per row.
//   - Recent access log (last 200), filterable by selected key.
//
// One-time token reveal: the plaintext token is only available in
// the create response. The page caches it in component state long
// enough to display + offer a copy button; refreshing the page
// without copying loses it forever.

type CreateState =
    | { kind: "idle" }
    | { kind: "creating" }
    | { kind: "revealed"; token: string; key: APIKey };

export default function APIKeys() {
    const [keys, setKeys] = useState<APIKey[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [name, setName] = useState("");
    const [createState, setCreateState] = useState<CreateState>({ kind: "idle" });
    const [logs, setLogs] = useState<APIAccessLogEntry[] | null>(null);
    const [logFilterKey, setLogFilterKey] = useState<number | null>(null);

    async function refreshKeys() {
        try {
            const res = await api.listAPIKeys();
            setKeys(res.keys);
        } catch (err) {
            setError(err instanceof Error ? err.message : "load failed");
        }
    }

    async function refreshLog() {
        try {
            if (logFilterKey) {
                const res = await api.listAPIKeyAccessLog(logFilterKey, 200);
                setLogs(res.entries);
            } else {
                const res = await api.listAPIAccessLog(200);
                setLogs(res.entries);
            }
        } catch (err) {
            // Don't surface log errors as fatal - the page still works
            // for the keys above.
            // eslint-disable-next-line no-console
            console.warn("access log fetch failed", err);
            setLogs([]);
        }
    }

    useEffect(() => {
        refreshKeys();
    }, []);
    useEffect(() => {
        refreshLog();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [logFilterKey]);

    async function create(e: React.FormEvent) {
        e.preventDefault();
        if (createState.kind === "creating") return;
        setError(null);
        setCreateState({ kind: "creating" });
        try {
            const res = await api.createAPIKey(name.trim());
            setCreateState({ kind: "revealed", token: res.token, key: res.key });
            setName("");
            await refreshKeys();
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
            setCreateState({ kind: "idle" });
        }
    }

    async function revoke(k: APIKey) {
        if (!confirm(`Revoke key "${k.name}"? Any client using it will lose access.`)) return;
        try {
            await api.revokeAPIKey(k.id);
            await refreshKeys();
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        }
    }

    async function remove(k: APIKey) {
        if (
            !confirm(
                `Delete key "${k.name}"? Access log entries pointing at it will be kept (with no name).`,
            )
        )
            return;
        try {
            await api.deleteAPIKey(k.id);
            await refreshKeys();
            await refreshLog();
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        }
    }

    async function copyToken() {
        if (createState.kind !== "revealed") return;
        try {
            await navigator.clipboard.writeText(createState.token);
        } catch {
            // best-effort; older browsers throw if no user gesture
        }
    }

    return (
        <div className="page">
            <div className="page-head">
                <div>
                    <h1>API keys</h1>
                    <p className="muted">
                        Bearer tokens for headless admin access. Use them with{" "}
                        <code>Authorization: Bearer jb_…</code>. Equivalent
                        permission to the admin cookie - no scopes in v1.
                    </p>
                </div>
            </div>

            {error && <div className="error">{error}</div>}

            <h2 className="section-title">New key</h2>
            <form className="apikey-create" onSubmit={create}>
                <label>
                    Name
                    <input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="e.g. tagging-llm"
                        required
                        disabled={createState.kind === "creating"}
                    />
                </label>
                <button type="submit" disabled={createState.kind === "creating"}>
                    {createState.kind === "creating" ? "Creating…" : "Create key"}
                </button>
            </form>
            {createState.kind === "revealed" && (
                <div className="apikey-revealed">
                    <p>
                        <strong>Copy this token now.</strong> It will not be
                        shown again. Jellybean only stores its hash.
                    </p>
                    <code className="apikey-token">{createState.token}</code>
                    <div className="apikey-revealed-actions">
                        <button onClick={copyToken}>Copy token</button>
                        <button
                            onClick={() => setCreateState({ kind: "idle" })}
                        >
                            I have it, dismiss
                        </button>
                    </div>
                </div>
            )}

            <h2 className="section-title">Existing keys</h2>
            {keys === null ? (
                <Spinner block size={36} label="Loading keys…" />
            ) : keys.length === 0 ? (
                <p className="muted">No keys yet.</p>
            ) : (
                <ul className="profile-list">
                    {keys.map((k) => {
                        const revoked = !!k.revokedAt;
                        return (
                            <li key={k.id}>
                                <div className="profile-row">
                                    <div className="profile-info">
                                        <div className="profile-name">
                                            {k.name}
                                            {revoked ? (
                                                <span className="apikey-revoked-pill">
                                                    revoked
                                                </span>
                                            ) : null}
                                        </div>
                                        <div className="muted">
                                            Created{" "}
                                            {new Date(
                                                k.createdAt * 1000,
                                            ).toLocaleString()}
                                            {k.lastUsedAt
                                                ? ` · last used ${new Date(k.lastUsedAt * 1000).toLocaleString()}`
                                                : " · never used"}
                                            {k.revokedAt
                                                ? ` · revoked ${new Date(k.revokedAt * 1000).toLocaleString()}`
                                                : ""}
                                        </div>
                                    </div>
                                    <div className="profile-actions">
                                        <button
                                            onClick={() =>
                                                setLogFilterKey(
                                                    logFilterKey === k.id ? null : k.id,
                                                )
                                            }
                                        >
                                            {logFilterKey === k.id ? "Show all log" : "View log"}
                                        </button>
                                        <button
                                            onClick={() => revoke(k)}
                                            disabled={revoked}
                                        >
                                            Revoke
                                        </button>
                                        <button onClick={() => remove(k)}>
                                            Delete
                                        </button>
                                    </div>
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}

            <h2 className="section-title">
                Access log
                {logFilterKey ? (
                    <span className="muted apikey-log-scope">
                        {" "}
                        · filtered to key #{logFilterKey}
                    </span>
                ) : null}
            </h2>
            {logs === null ? (
                <Spinner block size={28} label="Loading log…" />
            ) : logs.length === 0 ? (
                <p className="muted">No access log entries yet.</p>
            ) : (
                <table className="apikey-log">
                    <thead>
                        <tr>
                            <th>When</th>
                            <th>Method</th>
                            <th>Path</th>
                            <th>Status</th>
                            <th>Key</th>
                        </tr>
                    </thead>
                    <tbody>
                        {logs.map((e) => (
                            <tr key={e.id}>
                                <td>
                                    {new Date(e.occurredAt * 1000).toLocaleString()}
                                </td>
                                <td>{e.method}</td>
                                <td className="apikey-log-path">{e.path}</td>
                                <td>{e.status}</td>
                                <td>{e.keyId ?? "—"}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    );
}
