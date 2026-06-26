import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The web app talks to the server over VITE_API_BASE / VITE_WS_URL (browser
// envs). In docker compose the server is reachable on the host port mapping.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
  },
});
