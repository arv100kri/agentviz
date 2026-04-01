import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { FAX_VIZ_PORT } from "./src/fax-viz/lib/faxConstants.js";

export default defineConfig(function ({ mode }) {
  var isDebugBuild = mode === "debug";

  return {
    plugins: [react()],
    root: ".",
    build: {
      outDir: "dist-fax-viz",
      minify: isDebugBuild ? false : "esbuild",
      sourcemap: isDebugBuild,
      rollupOptions: {
        input: "fax-viz-index.html",
      },
    },
    server: {
      port: 3001,
      open: true,
      proxy: {
        "/api": {
          target: "http://127.0.0.1:" + FAX_VIZ_PORT,
          changeOrigin: true,
        },
      },
    },
    test: {
      exclude: ["node_modules", "e2e", "dist-fax-viz", "build"],
    },
  };
});
