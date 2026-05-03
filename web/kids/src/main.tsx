import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import Play from "./Play";
import Setup from "./Setup";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <BrowserRouter basename="/kids">
            <Routes>
                <Route path="/setup" element={<Setup />} />
                <Route path="/play/:itemId" element={<Play />} />
                <Route path="*" element={<Navigate to="/setup" replace />} />
            </Routes>
        </BrowserRouter>
    </React.StrictMode>,
);
