import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// In dev, /api/* goes to a local query node, the same way nginx does it in the container.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.TEMUPUFFER_URL ?? "http://localhost:8080",
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
});
