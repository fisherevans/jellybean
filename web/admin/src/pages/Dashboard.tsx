import { useEffect, useState } from "react";
import { api, HttpError, type Item, type User } from "../api";
import HlsVideo from "../HlsVideo";

type Props = {
    user: User;
    onLogout: () => void;
};

export default function Dashboard({ user, onLogout }: Props) {
    const [items, setItems] = useState<Item[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [playing, setPlaying] = useState<Item | null>(null);
    const [streamUrl, setStreamUrl] = useState<string | null>(null);

    useEffect(() => {
        api.listItems("Movie", 20)
            .then((res) => setItems(res.Items))
            .catch((err) => {
                if (err instanceof HttpError && err.status === 401) {
                    onLogout();
                    return;
                }
                setError(err.message || "Failed to load items.");
            });
    }, [onLogout]);

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

    async function handleLogout() {
        try {
            await api.logout();
        } catch {
            /* logout best-effort; clear UI anyway */
        }
        onLogout();
    }

    return (
        <div className="dashboard">
            <header>
                <h1>Jellybean</h1>
                <div className="user">
                    Signed in as <strong>{user.name}</strong>
                    <button onClick={handleLogout}>Sign out</button>
                </div>
            </header>

            <main>
                <p className="muted">
                    M1 streaming proof. Pick a movie below to verify the catalog read +
                    direct-play stream path.
                </p>

                {error && <div className="error">{error}</div>}

                {items === null ? (
                    <div className="muted">Loading items...</div>
                ) : items.length === 0 ? (
                    <div className="muted">No movies found in Jellyfin.</div>
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
                        <h2>{playing.Name}</h2>
                        {streamUrl ? (
                            <HlsVideo
                                key={playing.Id}
                                src={streamUrl}
                                style={{ width: "100%", maxWidth: 960 }}
                            />
                        ) : (
                            <div className="muted">Resolving stream...</div>
                        )}
                        <p className="muted">
                            HLS stream. Jellyfin direct-plays when codecs match,
                            transcodes to H.264/AAC otherwise. Seek anywhere; the
                            duration is real.
                        </p>
                    </div>
                )}
            </main>
        </div>
    );
}
