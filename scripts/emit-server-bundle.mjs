// Copies the self-contained server bundle `skybridge build` emits into the
// build output, where the console is started from (`alpic.json`'s
// `startCommand`, the Dockerfile's `CMD`).
//
// Why a bundle at all: the console's server imports `skybridge/server`, and
// starting it from `dist/__entry.js` means resolving that import from
// `node_modules` at run time, which is what kept `skybridge` in
// `dependencies` and its non-optional peers (react, react-dom, vite, nodemon,
// @skybridge/devtools) in every `npx @pipelex/mcp` install. The bundle inlines
// every package the server reaches, so nothing is read from `node_modules`
// once it runs and `skybridge` is a devDependency.
//
// Where it comes from: Skybridge's last build step writes a Vercel build
// output, whose one function is an esbuild bundle of `dist/__entry.js` with
// `process.env.NODE_ENV` defined to "production" and only `vite` and
// `@skybridge/devtools` left external, the two dev-only packages whose code
// paths that define strips. That path is Skybridge's Vercel output and not a
// promised interface, so this script refuses loudly when it moves, and
// `scripts/check-server-bundle.mjs` boots the copy from an empty directory on
// every `make check`.
import { copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FUNCTION_DIR = path.join(ROOT, ".vercel", "output", "functions", "mcp.func");
const SOURCE = path.join(FUNCTION_DIR, "index.js");
const TARGET = path.join(ROOT, "dist", "server.bundle.js");
// Written by the same `skybridge build`, before its Vercel step.
const ENTRY = path.join(ROOT, "dist", "__entry.js");

// The files Skybridge writes into the function directory beside the bundle.
// Anything else is a file the bundle needs next to it (esbuild's `file`
// loader copies a native addon there and rewrites the require to point at
// it), which a copy of `index.js` alone would silently leave behind.
const EXPECTED_FUNCTION_FILES = new Set(["index.js", ".vc-config.json", "package.json"]);

function fail(message) {
  process.stderr.write(`emit-server-bundle: ${message}\n`);
  process.exit(1);
}

if (!existsSync(SOURCE)) {
  fail(
    `${path.relative(ROOT, SOURCE)} does not exist. \`skybridge build\` used to emit its Vercel ` +
      "build output there; if a Skybridge upgrade moved or dropped it, find where the server " +
      "bundle went (or bundle dist/__entry.js with esbuild the same way) before shipping, " +
      "because the console starts from dist/server.bundle.js and skybridge is a devDependency.",
  );
}

// `skybridge build` deletes `dist/` before it compiles and `.vercel/output`
// before its Vercel step, so today a bundle older than this build's entry
// cannot exist. If an upgrade stopped writing the Vercel output, or wrote it
// elsewhere, the copy a previous build left in the gitignored `.vercel/` would
// still be here, and a local `docker build` (whose context carries `.vercel/`)
// would ship it without a word.
if (!existsSync(ENTRY) || statSync(SOURCE).mtimeMs < statSync(ENTRY).mtimeMs) {
  fail(
    `${path.relative(ROOT, SOURCE)} is older than ${path.relative(ROOT, ENTRY)}, so this build did not ` +
      "write it: it is left over from an earlier build. Find where `skybridge build` now writes its " +
      "server bundle before shipping.",
  );
}

const unexpected = readdirSync(FUNCTION_DIR).filter((name) => !EXPECTED_FUNCTION_FILES.has(name));
if (unexpected.length > 0) {
  fail(
    `the server bundle has files beside it that it may load at run time (${unexpected.join(", ")}). ` +
      "Copying index.js alone would leave them behind; ship them with the bundle first.",
  );
}

copyFileSync(SOURCE, TARGET);
process.stdout.write(
  `emit-server-bundle: ${path.relative(ROOT, SOURCE)} -> ${path.relative(ROOT, TARGET)}\n`,
);
