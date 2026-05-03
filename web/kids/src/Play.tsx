import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { authHeaders } from "./auth";
import HlsVideo from "./HlsVideo";

type StreamResponse = {
    streamUrl: string;
    itemId: string;
    itemName: string;
};

export default function Play() {
    const { itemId } = useParams();
    const [stream, setStream] = useState<StreamResponse | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!itemId) return;
        // Always include the API key header if we have one, but rely on the
        // session cookie too. Server picks: cookie (admin) > key (kid).
        fetch(`/api/kids/items/${encodeURIComponent(itemId)}/stream`, {
            credentials: "same-origin",
            headers: authHeaders(),
        })
            .then(async (res) => {
                if (res.status === 401) {
                    throw new Error(
                        "Not authenticated. Sign in as admin (/) or set a kid key in /kids/setup.",
                    );
                }
                if (!res.ok) {
                    const text = await res.text();
                    throw new Error(`${res.status} ${res.statusText}: ${text}`);
                }
                return res.json();
            })
            .then((data: StreamResponse) => setStream(data))
            .catch((err) => setError(String(err.message ?? err)));
    }, [itemId]);

    if (error) {
        return (
            <div className="screen">
                <p className="error">{error}</p>
                <Link to="/setup">Setup</Link>
            </div>
        );
    }
    if (!stream) {
        return <div className="screen">Loading...</div>;
    }
    return (
        <div className="screen">
            <h1>{stream.itemName}</h1>
            <HlsVideo
                key={stream.itemId}
                src={stream.streamUrl}
                style={{ width: "100%", maxWidth: 1280 }}
            />
        </div>
    );
}
