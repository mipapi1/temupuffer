import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// In dev, /api/* goes to a local search API, the same way nginx does it in the container.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    proxy: { "/api": { target: process.env.SEARCH_API_URL ?? "http://localhost:8090" } },
  },
});
