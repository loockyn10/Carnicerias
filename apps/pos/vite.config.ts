import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Marca de build visible en el diagnóstico del POS (ver src/lib/build-info.ts): todos los instaladores comparten número de versión.
function gitCommit(): string | null {
  try {
    const commit = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const dirty = execSync("git status --porcelain", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() !== "";
    return commit ? `${commit}${dirty ? "+" : ""}` : null;
  } catch {
    return null;
  }
}
const packageVersion = (JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string }).version;

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  define: {
    __POS_BUILD__: JSON.stringify({ version: packageVersion, builtAt: command === "build" ? new Date().toISOString() : null, commit: gitCommit() })
  },
  server: {
    port: 1420,
    strictPort: true,
    host: process.env.TAURI_DEV_HOST || false,
    watch: { ignored: ["**/src-tauri/**"] }
  },
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG)
  }
}));
