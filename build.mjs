/**
 * esbuild bundler — produces a single dist/index.js with all dependencies inlined.
 *
 * Eliminates the need for `npm install` at plugin install time.
 * OpenClaw plugin APIs are consumed via host-provided runtime objects and type-only imports.
 * The published bundle must not rely on resolving `openclaw/plugin-sdk` from the installed extension directory.
 */
import esbuild from "esbuild";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));

// pino + thread-stream require CJS worker files at runtime.
// We copy them as .cjs (bypasses package.json "type":"module") and tell the libs
// where to find them via globalThis.__bundlerPathsOverrides injected in the banner.
// See: node_modules/pino/docs/bundling.md
const workerOverridesBanner = `
import { createRequire as __oc_createRequire } from "module";
import { fileURLToPath as __oc_fileURLToPath } from "url";
import { dirname as __oc_dirname, join as __oc_join } from "path";
const __oc_filename = __oc_fileURLToPath(import.meta.url);
const __oc_dirnameVal = __oc_dirname(__oc_filename);
globalThis.__bundlerPathsOverrides = {
  "thread-stream-worker": __oc_join(__oc_dirnameVal, "lib", "worker.cjs"),
  "pino-worker": __oc_join(__oc_dirnameVal, "worker.cjs"),
};
`.trim();

await esbuild.build({
  entryPoints: ["index.ts"],
  bundle: true,
  outfile: "dist/index.js",
  format: "esm",
  platform: "node",
  target: "es2022",
  external: ["openclaw", "openclaw/*"],
  sourcemap: true,
  banner: { js: workerOverridesBanner },
  define: {
    __PLUGIN_VERSION__: JSON.stringify(pkg.version),
    __PACKAGE_NAME__: JSON.stringify(pkg.name),
  },
});

console.log(`Built dist/index.js (${pkg.name}@${pkg.version})`);

// Copy intake config JSON files to configs/ (loaded at runtime via createRequire).
// In the bundle, import.meta.url resolves to dist/index.js, so ../configs/ = <package_root>/configs/.
await fs.mkdir(path.resolve("configs"), { recursive: true });
const intakeConfigsDir = path.resolve("lib/intake/configs");
const intakeConfigFiles = (await fs.readdir(intakeConfigsDir)).filter(f => f.endsWith(".json"));
await Promise.all(
  intakeConfigFiles.map(f => fs.copyFile(path.join(intakeConfigsDir, f), path.resolve("configs", f)))
);
console.log(`Copied ${intakeConfigFiles.length} intake config files to configs/`);

// Clean up stale worker files from previous builds.
await fs.rm(path.resolve("dist/worker.js"), { force: true });
await fs.rm(path.resolve("dist/lib/worker.js"), { force: true });

// Bundle pino/thread-stream workers as self-contained CJS files.
// These run inside Node.js Worker threads and need all their deps inlined.
// .cjs extension forces CommonJS regardless of package.json "type":"module".
// Paths must match __bundlerPathsOverrides injected via banner above.
await fs.mkdir(path.resolve("dist/lib"), { recursive: true });

await Promise.all([
  esbuild.build({
    entryPoints: ["node_modules/thread-stream/lib/worker.js"],
    bundle: true,
    outfile: "dist/lib/worker.cjs",
    format: "cjs",
    platform: "node",
    target: "es2022",
  }),
  esbuild.build({
    entryPoints: ["node_modules/pino/lib/worker.js"],
    bundle: true,
    outfile: "dist/worker.cjs",
    format: "cjs",
    platform: "node",
    target: "es2022",
    // pino-pretty is loaded dynamically at runtime via transport target — keep external
    external: ["pino-pretty"],
  }),
]);
console.log("Bundled pino/thread-stream workers to dist/ (.cjs)");

// Genesis runtime assets — copy from mono-repo parent if available.
// In the standalone (published) repo, genesis/ is committed source and must not be touched.
const genesisSourceRoot = path.resolve("..", "genesis");
const packagedGenesisRoot = path.resolve("genesis");

let genesisSourceExists = false;
try {
  await fs.access(genesisSourceRoot);
  genesisSourceExists = true;
} catch {
  // ../genesis/ does not exist — standalone repo
}

if (genesisSourceExists) {
  // Mono-repo context: parent genesis/ exists, sync it into the plugin
  await fs.rm(packagedGenesisRoot, { recursive: true, force: true });
  await fs.mkdir(packagedGenesisRoot, { recursive: true });
  await fs.cp(path.join(genesisSourceRoot, "scripts"), path.join(packagedGenesisRoot, "scripts"), {
    recursive: true,
  });
  await fs.cp(path.join(genesisSourceRoot, "configs"), path.join(packagedGenesisRoot, "configs"), {
    recursive: true,
  });
  console.log(`Copied genesis runtime assets to ${packagedGenesisRoot}`);
} else {
  console.log("Standalone mode: genesis/ already present, skipping copy");
}
