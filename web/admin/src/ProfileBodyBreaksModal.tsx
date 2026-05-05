import { useEffect, useState } from "react";
import { api, HttpError, type Profile, type ProfileBodyBreaks } from "./api";

// M11 #73: per-profile body-breaks config. Cadence (play_minutes /
// break_minutes), voice message template, and the list of reasons
// the engine picks from each break.

type Props = {
    profile: Profile;
    onClose: () => void;
};

export default function ProfileBodyBreaksModal({ profile, onClose }: Props) {
    const [cfg, setCfg] = useState<ProfileBodyBreaks | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [reasonsRaw, setReasonsRaw] = useState("");

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const got = await api.getProfileBodyBreaks(profile.id);
                if (!cancelled) {
                    setCfg(got);
                    setReasonsRaw((got.reasons ?? []).join("\n"));
                }
            } catch (err) {
                if (!cancelled) setError(err instanceof Error ? err.message : "load failed");
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [profile.id]);

    if (!cfg) {
        return (
            <Modal onClose={onClose} title={`Body breaks - ${profile.name}`}>
                {error ? <p className="error">{error}</p> : <p>Loading...</p>}
            </Modal>
        );
    }

    function set<K extends keyof ProfileBodyBreaks>(key: K, v: ProfileBodyBreaks[K]) {
        setCfg((c) => (c ? { ...c, [key]: v } : c));
    }

    async function save() {
        if (!cfg) return;
        const reasons = reasonsRaw
            .split("\n")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        setSaving(true);
        setError(null);
        try {
            await api.setProfileBodyBreaks(profile.id, { ...cfg, reasons });
            onClose();
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        } finally {
            setSaving(false);
        }
    }

    return (
        <Modal onClose={onClose} title={`Body breaks - ${profile.name}`}>
            <div className="modal-form">
                <label className="checkbox">
                    <input
                        type="checkbox"
                        checked={cfg.enabled}
                        onChange={(e) => set("enabled", e.target.checked)}
                    />
                    Enable body breaks for this profile
                </label>
                <p className="muted">
                    The kid will be locked into a break overlay after the
                    configured continuous-play threshold. The accumulator
                    decays on pause / menu / browse and resets on
                    cross-content swap (next episode of the same series
                    does NOT reset).
                </p>

                <label>
                    Play before break (minutes)
                    <input
                        type="number"
                        min={1}
                        max={240}
                        value={cfg.playMinutes}
                        onChange={(e) => set("playMinutes", Number(e.target.value))}
                    />
                </label>

                <label>
                    Break duration (minutes)
                    <input
                        type="number"
                        min={1}
                        max={60}
                        value={cfg.breakMinutes}
                        onChange={(e) => set("breakMinutes", Number(e.target.value))}
                    />
                </label>

                <label>
                    Voice message template
                    <input
                        type="text"
                        value={cfg.voiceMessageTemplate}
                        onChange={(e) =>
                            set("voiceMessageTemplate", e.target.value)
                        }
                    />
                </label>
                <p className="muted">
                    Use <code>{"{reason}"}</code> as a placeholder for the
                    randomly selected reason.
                </p>

                <label>
                    Reasons (one per line)
                    <textarea
                        rows={4}
                        value={reasonsRaw}
                        onChange={(e) => setReasonsRaw(e.target.value)}
                    />
                </label>

                {error && <p className="error">{error}</p>}

                <div className="modal-actions">
                    <button onClick={onClose} disabled={saving}>
                        Cancel
                    </button>
                    <button
                        onClick={save}
                        disabled={saving}
                        className="primary"
                    >
                        {saving ? "Saving..." : "Save"}
                    </button>
                </div>
            </div>
        </Modal>
    );
}

type ModalProps = {
    onClose: () => void;
    title: string;
    children: React.ReactNode;
};

function Modal({ onClose, title, children }: ModalProps) {
    return (
        <div className="modal-backdrop" onClick={onClose}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-head">
                    <h3>{title}</h3>
                    <button className="modal-close" onClick={onClose}>
                        ×
                    </button>
                </div>
                {children}
            </div>
        </div>
    );
}
