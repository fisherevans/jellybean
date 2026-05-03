import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { api, HttpError, type User } from "./api";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";

type AuthState =
    | { status: "loading" }
    | { status: "authed"; user: User }
    | { status: "unauthed" };

export default function App() {
    const [auth, setAuth] = useState<AuthState>({ status: "loading" });

    useEffect(() => {
        api.me()
            .then((user) => setAuth({ status: "authed", user }))
            .catch((err) => {
                if (err instanceof HttpError && err.status === 401) {
                    setAuth({ status: "unauthed" });
                } else {
                    setAuth({ status: "unauthed" });
                }
            });
    }, []);

    if (auth.status === "loading") {
        return <div className="screen-message">Loading...</div>;
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
            <Route
                path="/"
                element={
                    auth.status === "authed" ? (
                        <Dashboard
                            user={auth.user}
                            onLogout={() => setAuth({ status: "unauthed" })}
                        />
                    ) : (
                        <RedirectToLogin />
                    )
                }
            />
        </Routes>
    );
}

function RedirectToLogin() {
    const nav = useNavigate();
    useEffect(() => {
        nav("/login", { replace: true });
    }, [nav]);
    return null;
}
