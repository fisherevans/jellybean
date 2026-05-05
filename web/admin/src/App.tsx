import { useEffect, useState } from "react";
import { Navigate, Outlet, Route, Routes, useNavigate } from "react-router-dom";
import { api, type User } from "./api";
import Layout from "./Layout";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Activity from "./pages/Activity";
import Profiles from "./pages/Profiles";
import ProfileSettings from "./pages/ProfileSettings";
import Categorize from "./pages/Categorize";
import AdminHub from "./pages/AdminHub";
import Browse from "./pages/Browse";
import SettingsLayout from "./SettingsLayout";
import Kids from "./pages/Kids";
import Tags from "./pages/Tags";
import TagDetail from "./pages/TagDetail";
import Layouts from "./pages/Layouts";
import LayoutDetail from "./pages/LayoutDetail";
import APIKeys from "./pages/APIKeys";
import Settings from "./pages/Settings";
import NotFound from "./pages/NotFound";
import Spinner from "./Spinner";

type AuthState =
    | { status: "loading" }
    | { status: "authed"; user: User }
    | { status: "unauthed" };

export default function App() {
    const [auth, setAuth] = useState<AuthState>({ status: "loading" });

    useEffect(() => {
        api.me()
            .then((user) => setAuth({ status: "authed", user }))
            .catch(() => setAuth({ status: "unauthed" }));
    }, []);

    if (auth.status === "loading") {
        return (
            <div className="screen-message">
                <Spinner block size={48} label="Loading…" />
            </div>
        );
    }

    return (
        <Routes>
            <Route
                path="/login"
                element={
                    auth.status === "authed" ? (
                        <Navigate to="/" replace />
                    ) : (
                        <Login onSuccess={(u) => setAuth({ status: "authed", user: u })} />
                    )
                }
            />
            {auth.status === "authed" ? (
                <Route
                    element={
                        <Layout
                            user={auth.user}
                            onLogout={() => setAuth({ status: "unauthed" })}
                        />
                    }
                >
                    <Route
                        path="/"
                        element={
                            <Dashboard
                                user={auth.user}
                                onLogout={() => setAuth({ status: "unauthed" })}
                            />
                        }
                    />
                    <Route path="/bulk" element={<Categorize />} />
                    <Route path="/swipe" element={<Categorize />} />
                    <Route path="/categorize" element={<Categorize />} />
                    <Route path="/browse" element={<Browse />} />
                    {/* /search is collapsed into /browse - keep the
                        route as a redirect so legacy bookmarks work. */}
                    <Route
                        path="/search"
                        element={<Navigate to="/browse" replace />}
                    />
                    <Route path="/tags" element={<Tags />} />
                    <Route path="/tags/:tagId" element={<TagDetail />} />
                    {/* /items/:itemId opens the Browse page with the
                        item editor modal pre-opened. Used by the M9
                        QR-code deep link. */}
                    <Route path="/items/:itemId" element={<Browse />} />
                    {/* Admin / settings routes share a sidebar layout. */}
                    <Route element={<SettingsLayout />}>
                        <Route path="/admin" element={<AdminHub />} />
                        <Route path="/activity" element={<Activity />} />
                        <Route path="/profiles" element={<Profiles />} />
                        <Route
                            path="/profiles/:id"
                            element={<ProfileSettings />}
                        />
                        <Route path="/kids" element={<Kids />} />
                        <Route path="/layouts" element={<Layouts />} />
                        <Route
                            path="/layouts/:layoutId"
                            element={<LayoutDetail />}
                        />
                        <Route path="/api-keys" element={<APIKeys />} />
                        <Route path="/settings" element={<Settings />} />
                    </Route>
                    {/* Catch-all 404 inside the authed layout so users
                        keep the top nav + sign-out affordance. */}
                    <Route path="*" element={<NotFound />} />
                </Route>
            ) : (
                <Route path="*" element={<RedirectToLogin />} />
            )}
        </Routes>
    );
}

function RedirectToLogin() {
    const nav = useNavigate();
    useEffect(() => {
        nav("/login", { replace: true });
    }, [nav]);
    return <Outlet />;
}

