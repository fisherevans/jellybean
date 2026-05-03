import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, HttpError, type Item, type User } from "../api";
import { useActiveProfile } from "../activeProfile";
import HlsVideo from "../HlsVideo";

type Props = {
    user: User;
    onLogout: () => void;
};

// The dashboard is now mostly a "you're in - go curate" landing page with a
// small playback preview at the bottom for the M1 streaming smoke test
// (still useful when validating Jellyfin connectivity after a deploy).
export default function Dashboard({ user, onLogout }: Props) {
    const { profile } = useActiveProfile();
    const [items, setItems] = useState<Item[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [playing, setPlaying] = useState<Item | null>(null);
    const [streamUrl, setStreamUrl] = useState<string | null>(null);

    useEffect(() => {
        if (!profile) return;
        setError(null);
        setItems(null);
        api.listItems({ profileId: profile.id, type: "Movie", limit: 6 })
            .then((res) => setItems(res.Items))
            .catch((err) => {
                if (err instanceof HttpError && err.status === 401) {
                    onLogout();
                    return;
                }
                setError(err.message || "Failed to load items.");
            });
    }, [onLogout, profile?.id]);

    useEffect(() => {
        if (!playing) {
            setStreamUrl(null);
            return;
        }
        let cancelled = false;
        setStreamUrl(null);
        api.getStream(playing.Id)
            .then((info) => {
                if (!cancelled) setStreamUrl(info.streamUrl);
            })
            .catch((err) => {
                if (!cancelled) setError(err.message || "Failed to resolve stream.");
            });
        return () => {
            cancelled = true;
        };
    }, [playing]);

    return (
        <div className="page">
            <h1>Welcome, {user.name}</h1>
            <p className="muted">
                Use the nav above to start curating. The fastest path is{" "}
                <Link to="/sweep">Sweep</Link> for bulk categorization, then{" "}
                <Link to="/triage">Triage</Link> for the long tail.
            </p>

            {error && <div className="error">{error}</div>}

            <h2>Streaming smoke test</h2>
            <p className="muted">
                A small picker for verifying Jellyfin connectivity + HLS playback
                end to end.
            </p>

            {items === null ? (
                <p className="muted">Loading...</p>
            ) : (
                <ul className="item-list">
                    {items.map((item) => (
                        <li key={item.Id}>
                            <button
                                className={`item${playing?.Id === item.Id ? " active" : ""}`}
                                onClick={() => setPlaying(item)}
                            >
                                <span className="name">{item.Name}</span>
                                <span className="meta">
                                    {item.ProductionYear ?? ""}{" "}
                                    {item.OfficialRating ? `· ${item.OfficialRating}` : ""}
                                </span>
                            </button>
                            <a
                                className="kids-link"
                                href={`/kids/play/${item.Id}`}
                                target="_blank"
                                rel="noreferrer"
                                title="Open in kids view (uses your admin session)"
                            >
                                open in kids view ↗
                            </a>
                        </li>
                    ))}
                </ul>
            )}

            {playing && (
                <div className="player">
                    <h3>{playing.Name}</h3>
                    {streamUrl ? (
                        <HlsVideo
                            key={playing.Id}
                            src={streamUrl}
                            style={{ width: "100%", maxWidth: 960 }}
                        />
                    ) : (
                        <div className="muted">Resolving stream...</div>
                    )}
                </div>
            )}
        </div>
    );
}
