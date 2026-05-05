import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The admin app is served by the Go binary at /manage, so all asset
// URLs need to be /manage-prefixed for both dev and prod builds.
export default defineConfig({
    plugins: [react()],
    base: "/manage/",
    server: {
        port: 5173,
        proxy: {
            "/api": "http://localhost:8080",
        },
    },
    build: {
        outDir: "dist",
        emptyOutDir: true,
    },
});
