import { useEffect, useState } from "react";
import { Navigate, Outlet, Route, Routes, useNavigate } from "react-router-dom";
import { api, type User } from "./api";
import Layout from "./Layout";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Bulk from "./pages/Bulk";
import Swipe from "./pages/Swipe";
import Activity from "./pages/Activity";
import Search from "./pages/Search";
import Profiles from "./pages/Profiles";
import Kids from "./pages/Kids";
import Tags from "./pages/Tags";
import TagDetail from "./pages/TagDetail";
import Layouts from "./pages/Layouts";
import LayoutDetail from "./pages/LayoutDetail";
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
                    <Route path="/bulk" element={<Bulk />} />
                    <Route path="/swipe" element={<Swipe />} />
                    <Route path="/activity" element={<Activity />} />
                    <Route path="/search" element={<Search />} />
                    <Route path="/profiles" element={<Profiles />} />
                    <Route path="/manage-kids" element={<Kids />} />
                    <Route path="/tags" element={<Tags />} />
                    <Route path="/tags/:tagId" element={<TagDetail />} />
                    <Route path="/layouts" element={<Layouts />} />
                    <Route path="/layouts/:layoutId" element={<LayoutDetail />} />
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

