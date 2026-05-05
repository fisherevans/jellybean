import { useEffect, useState } from "react";
import { api, HttpError, type Profile, type ProfileViewingControls } from "./api";

// M12 #78: per-profile viewing-controls config (dim, red-shift,
// clock-based auto-off).

type Props = {
    profile: Profile;
    onClose: () => void;
};

export default function ProfileViewingControlsModal({ profile, onClose }: Props) {
    const [cfg, setCfg] = useState<ProfileViewingControls | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const got = await api.getProfileViewingControls(profile.id);
                if (!cancelled) setCfg(got);
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
            <Modal onClose={onClose} title={`Viewing controls - ${profile.name}`}>
                {error ? <p className="error">{error}</p> : <p>Loading...</p>}
            </Modal>
        );
    }

    function set<K extends keyof ProfileViewingControls>(
        key: K,
        v: ProfileViewingControls[K],
    ) {
        setCfg((c) => (c ? { ...c, [key]: v } : c));
    }

    async function save() {
        if (!cfg) return;
        setSaving(true);
        setError(null);
        try {
            await api.setProfileViewingControls(profile.id, cfg);
            onClose();
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        } finally {
            setSaving(false);
        }
    }

    return (
        <Modal onClose={onClose} title={`Viewing controls - ${profile.name}`}>
            <div className="modal-form">
                <p className="muted">
                    Per-profile baselines for the kid SPA's CSS filter
                    effects. Per-kid overrides (with TTL) are set via the
                    M9 override modal at runtime.
                </p>

                <label>
                    Dim (% darker, 0-80)
                    <input
                        type="number"
                        min={0}
                        max={80}
                        value={cfg.dimPercent}
                        onChange={(e) => set("dimPercent", Number(e.target.value))}
                    />
                </label>

                <label>
                    Red shift (% warm, 0-100)
                    <input
                        type="number"
                        min={0}
                        max={100}
                        value={cfg.redShiftPercent}
                        onChange={(e) =>
                            set("redShiftPercent", Number(e.target.value))
                        }
                    />
                </label>

                <label>
                    Auto-off at clock time (HH:MM 24h, blank to disable)
                    <input
                        type="text"
                        placeholder="20:30"
                        value={cfg.autoOffClockTime ?? ""}
                        onChange={(e) =>
                            set("autoOffClockTime", e.target.value)
                        }
                    />
                </label>

                <label className="checkbox">
                    <input
                        type="checkbox"
                        checked={cfg.autoOffOnTimeLimit}
                        onChange={(e) =>
                            set("autoOffOnTimeLimit", e.target.checked)
                        }
                    />
                    Auto-off when M10 time limit hits zero
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
