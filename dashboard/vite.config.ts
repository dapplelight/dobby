import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// Builds to dashboard/dist, which dashboard-server.ts serves. Dev: `vite --config dashboard/vite.config.ts` proxies /api to a running dashboard.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true, manifest: true }, // the manifest is what scripts/check-bundle.ts reads
  server: { proxy: { "/api": "http://127.0.0.1:4710" } },
})
