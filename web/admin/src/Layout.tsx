import { Link, NavLink, Outlet } from "react-router-dom";
import { api, type User } from "./api";

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
    { to: "/kids", label: "Kids" },
];

export default function Layout({ user, onLogout }: Props) {
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
