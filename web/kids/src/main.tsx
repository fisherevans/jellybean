import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { getSession } from "./auth";
import Library from "./Library";
import Login from "./Login";
import Play from "./Play";
import { prefetchLibrary } from "./prefetch";
import "./styles.css";

// Index gates the / route: signed-in users land at /library, everyone
// else gets bounced to /login. Library itself runs the same check (so
// deep links don't bypass it), but doing it here keeps the initial
// render free of a flicker through the library shell.
//
// Side effect: when we know we're about to navigate the user to
// /library, kick off a background prefetch so the cache is warm by the
// time Library mounts. Fire-and-forget; the prefetch module gates
// duplicates internally.
function Index() {
    const signedIn = !!getSession();
    if (signedIn) prefetchLibrary();
    return <Navigate to={signedIn ? "/library" : "/login"} replace />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <BrowserRouter basename="/kids">
            <Routes>
                <Route path="/" element={<Index />} />
                <Route path="/login" element={<Login />} />
                <Route path="/library" element={<Library />} />
                <Route path="/play/:itemId" element={<Play />} />
                <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
        </BrowserRouter>
    </React.StrictMode>,
);
