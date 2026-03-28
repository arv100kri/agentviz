import { defineConfig } from "vite";
import { fileURLToPath } from "url";

var cliEntry = fileURLToPath(new URL("./src/cli/index.js", import.meta.url));

export default defineConfig({
  build: {
    lib: {
      entry: cliEntry,
      formats: ["es"],
      fileName: function () {
        return "index.js";
      },
    },
    outDir: "dist-cli",
    minify: false,
    sourcemap: true,
    rollupOptions: {
      external: ["@github/copilot-sdk"],
    },
  },
});
