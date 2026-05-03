import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The kids app is served by the Go binary at /kids, so all asset URLs need
// to be /kids-prefixed. base: "/kids/" handles that for both dev and prod.
export default defineConfig({
    plugins: [react()],
    base: "/kids/",
    server: {
        port: 5174,
        proxy: {
            "/api": "http://localhost:8080",
        },
    },
    build: {
        outDir: "dist",
        emptyOutDir: true,
    },
});
