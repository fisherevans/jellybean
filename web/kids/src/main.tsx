import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import Library from "./Library";
import Play from "./Play";
import Profiles from "./Profiles";
import Setup from "./Setup";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <BrowserRouter basename="/kids">
            <Routes>
                <Route path="/" element={<Profiles />} />
                <Route path="/setup" element={<Setup />} />
                <Route path="/library" element={<Library />} />
                <Route path="/play/:itemId" element={<Play />} />
                <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
        </BrowserRouter>
    </React.StrictMode>,
);
