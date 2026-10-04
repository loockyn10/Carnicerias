import { defineConfig } from "vitest/config";

// Los componentes se escriben en TSX con `jsx: preserve` (lo compila Next); para los tests de render alcanza el runtime automático.
// (Sin `include`: se conserva el patrón por defecto de vitest, que también corre los tests de `scripts/`.)
export default defineConfig({ esbuild: { jsx: "automatic" } });
