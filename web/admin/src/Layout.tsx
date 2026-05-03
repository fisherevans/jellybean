import { Link, NavLink, Outlet } from "react-router-dom";
import { api, type User } from "./api";
import { useActiveProfile } from "./activeProfile";

type Props = {
    user: User;
    onLogout: () => void;
};

const links = [
    { to: "/", label: "Home" },
    { to: "/sweep", label: "Sweep" },
    { to: "/triage", label: "Triage" },
    { to: "/activity", label: "Activity" },
    { to: "/search", label: "Search" },
    { to: "/profiles", label: "Profiles" },
    { to: "/manage-kids", label: "Kids" },
];

export default function Layout({ user, onLogout }: Props) {
    const { profile, profiles, setActive } = useActiveProfile();

    async function handleLogout() {
        try {
            await api.logout();
        } catch {
            /* ignore */
        }
        onLogout();
    }

    return (
        <div className="layout">
            <header className="topbar">
                <Link to="/" className="brand">
                    <img
                        src="/jellybean-admin.png"
                        alt=""
                        className="brand-mark"
                        width={32}
                        height={32}
                    />
                    Jellybean
                </Link>
                <nav className="nav">
                    {links.map((l) => (
                        <NavLink
                            key={l.to}
                            to={l.to}
                            end={l.to === "/"}
                            className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}
                        >
                            {l.label}
                        </NavLink>
                    ))}
                </nav>
                <div className="user">
                    {profiles.length > 0 && (
                        <label className="profile-pick">
                            <span>Profile</span>
                            <select
                                value={profile?.id ?? ""}
                                onChange={(e) => setActive(Number(e.target.value))}
                            >
                                {profiles.map((p) => (
                                    <option key={p.id} value={p.id}>
                                        {p.name}
                                    </option>
                                ))}
                            </select>
                        </label>
                    )}
                    <span>{user.name}</span>
                    <button onClick={handleLogout}>Sign out</button>
                </div>
            </header>
            <main className="content">
                <Outlet />
            </main>
        </div>
    );
}
