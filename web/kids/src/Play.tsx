import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";

const KEY_STORAGE = "jellybean.kids.key";

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
        const key = localStorage.getItem(KEY_STORAGE);
        if (!key) {
            setError("No kid API key on this device. Visit /kids/setup first.");
            return;
        }
        fetch(`/api/kids/items/${encodeURIComponent(itemId)}/stream`, {
            headers: { "X-Jellybean-Key": key },
        })
            .then(async (res) => {
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
            <video
                key={stream.itemId}
                src={stream.streamUrl}
                controls
                autoPlay
                style={{ width: "100%", maxWidth: 1280 }}
            />
        </div>
    );
}
