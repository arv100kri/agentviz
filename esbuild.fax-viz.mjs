/**
 * esbuild config for bundling fax-viz into a single distributable server file.
 * Produces: build/fax-viz-server.mjs (+ dist-fax-viz/ copied alongside)
 *
 * Usage: node esbuild.fax-viz.mjs
 */

import esbuild from "esbuild";
import fs from "fs";
import path from "path";

var BUILD_DIR = "build";

// Clean and create build dir
if (fs.existsSync(BUILD_DIR)) {
  fs.rmSync(BUILD_DIR, { recursive: true });
}
fs.mkdirSync(BUILD_DIR, { recursive: true });

// Bundle the server entry point
await esbuild.build({
  entryPoints: ["bin/fax-viz.js"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  outfile: path.join(BUILD_DIR, "fax-viz-server.mjs"),
  minify: true,
  sourcemap: false,
  external: [
    "@github/copilot-sdk",
    "@github/copilot",
  ],
  // Suppress warnings about dynamic require in dependencies
  logLevel: "warning",
  banner: {
    js: "// fax-viz bundled server\n",
  },
});

// Copy dist-fax-viz/ alongside the bundle
var distSrc = "dist-fax-viz";
var distDest = path.join(BUILD_DIR, "dist-fax-viz");
if (fs.existsSync(distSrc)) {
  fs.cpSync(distSrc, distDest, { recursive: true });
  console.log("  Copied dist-fax-viz/ to build/");
} else {
  console.warn("  WARNING: dist-fax-viz/ not found — run npm run build:fax-viz first");
}

// Report sizes
var serverSize = fs.statSync(path.join(BUILD_DIR, "fax-viz-server.mjs")).size;
var distSize = 0;
if (fs.existsSync(distDest)) {
  var walk = function (dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
      else distSize += fs.statSync(path.join(dir, entry.name)).size;
    });
  };
  walk(distDest);
}

console.log("");
console.log("  fax-viz bundle built successfully:");
console.log("    Server:  " + (serverSize / 1024).toFixed(1) + " KB");
console.log("    Assets:  " + (distSize / 1024).toFixed(1) + " KB");
console.log("    Total:   " + ((serverSize + distSize) / 1024).toFixed(1) + " KB");
console.log("");
console.log("  Run with: node build/fax-viz-server.mjs --fax-dir <path>");
console.log("");
