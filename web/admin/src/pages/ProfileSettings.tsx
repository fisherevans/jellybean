import { useCallback, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, type Profile } from "../api";
import ProfileBasicForm from "../ProfileBasicForm";
import ProfileTagFiltersForm from "../ProfileTagFiltersForm";
import ProfileTimeLimitsForm from "../ProfileTimeLimitsForm";
import ProfileBodyBreaksForm from "../ProfileBodyBreaksForm";
import ProfileViewingControlsForm from "../ProfileViewingControlsForm";
import ProfileModesForm from "../ProfileModesForm";
import ProfileChannelsForm from "../ProfileChannelsForm";
import Spinner from "../Spinner";

// Single-page profile settings. Tabbed layout replaces the older row
// of modal-launching buttons on the profile list. Each tab is its
// own form with its own Save button - changes don't auto-apply, and
// switching tabs while dirty discards (matching the modal-era
// behavior so the shape isn't suddenly different).

type TabKey =
    | "basic"
    | "tag-rules"
    | "time-limits"
    | "body-breaks"
    | "viewing"
    | "modes"
    | "channels";

const TABS: Array<{ key: TabKey; label: string }> = [
    { key: "basic", label: "Basic" },
    { key: "tag-rules", label: "Tag rules" },
    { key: "time-limits", label: "Time limits" },
    { key: "body-breaks", label: "Body breaks" },
    { key: "viewing", label: "Viewing" },
    { key: "modes", label: "Modes" },
    { key: "channels", label: "Channels" },
];

function isTab(s: string | null): s is TabKey {
    return TABS.some((t) => t.key === s);
}

export default function ProfileSettings() {
    const { id } = useParams<{ id: string }>();
    const profileId = Number(id);
    const [searchParams, setSearchParams] = useSearchParams();
    const tab: TabKey = isTab(searchParams.get("tab"))
        ? (searchParams.get("tab") as TabKey)
        : "basic";

    const [profile, setProfile] = useState<Profile | null>(null);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        try {
            const res = await api.listProfiles();
            const p = res.profiles.find((x) => x.id === profileId);
            if (!p) {
                setError("Profile not found");
                return;
            }
            setProfile(p);
        } catch (err) {
            setError(err instanceof Error ? err.message : "load failed");
        }
    }, [profileId]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    if (error) {
        return (
            <div className="page">
                <p className="error">{error}</p>
                <Link to="/profiles">← Back to profiles</Link>
            </div>
        );
    }
    if (!profile) {
        return (
            <div className="page">
                <Spinner block size={36} label="Loading profile..." />
            </div>
        );
    }

    function selectTab(key: TabKey) {
        setSearchParams({ tab: key });
    }

    return (
        <div className="page profile-settings">
            <div className="profile-settings-head">
                <Link to="/profiles" className="profile-settings-back">
                    ← Profiles
                </Link>
                <h1>{profile.name}</h1>
                {profile.description && (
                    <p className="muted">{profile.description}</p>
                )}
            </div>

            <nav className="settings-tabs" role="tablist">
                {TABS.map((t) => (
                    <button
                        key={t.key}
                        role="tab"
                        aria-selected={tab === t.key}
                        className={`settings-tab ${tab === t.key ? "active" : ""}`}
                        onClick={() => selectTab(t.key)}
                    >
                        {t.label}
                    </button>
                ))}
            </nav>

            <div className="settings-panel" role="tabpanel">
                {tab === "basic" && (
                    <ProfileBasicForm
                        key={profile.id}
                        profile={profile}
                        onSaved={(next) => setProfile(next)}
                    />
                )}
                {tab === "tag-rules" && (
                    <ProfileTagFiltersForm key={profile.id} profile={profile} />
                )}
                {tab === "time-limits" && (
                    <ProfileTimeLimitsForm
                        key={profile.id}
                        profileId={profile.id}
                    />
                )}
                {tab === "body-breaks" && (
                    <ProfileBodyBreaksForm
                        key={profile.id}
                        profileId={profile.id}
                    />
                )}
                {tab === "viewing" && (
                    <ProfileViewingControlsForm
                        key={profile.id}
                        profileId={profile.id}
                    />
                )}
                {tab === "modes" && (
                    <ProfileModesForm
                        key={profile.id}
                        profileId={profile.id}
                    />
                )}
                {tab === "channels" && (
                    <ProfileChannelsForm
                        key={profile.id}
                        profileId={profile.id}
                    />
                )}
            </div>
        </div>
    );
}
