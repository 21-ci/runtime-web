import { fileURLToPath, URL } from "node:url";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Dependency-free branding colour/token module shared with the server (one source of truth).
      "@shared-branding": fileURLToPath(new URL("../server/src/branding/shared", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // RTWEB_DEV_PROXY=http://console.localhost:18443 forwards /api to a running backend while
    // the console itself is served by Vite (cookies are first-party on localhost, the Origin
    // header is rewritten so the server's same-origin check passes).
    proxy: process.env.RTWEB_DEV_PROXY
      ? {
          "/api": {
            target: process.env.RTWEB_DEV_PROXY,
            changeOrigin: true,
            headers: { origin: process.env.RTWEB_DEV_PROXY },
          },
        }
      : undefined,
  },
});
