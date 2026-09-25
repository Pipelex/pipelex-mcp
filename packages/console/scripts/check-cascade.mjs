#!/usr/bin/env node
/**
 * check-cascade.mjs — assert COMPUTED cascade outcomes in the built console stylesheet.
 *
 * Why this exists, precisely. The console bundles two Tailwind builds: this app's, and
 * the form kernel's prebuilt sheet that `@pipelex/mthds-ui/form/react` imports as a side
 * effect inside `@layer mthds-form`. Which of them wins a given declaration is decided by
 * the layer order `src/index.css` declares — and getting it wrong is silent in both
 * directions. With the kernel too low, Tailwind's preflight beats every kernel-only
 * utility and each control in RunPanel renders with no surface and no padding, inside a
 * panel whose own chrome is unlayered and still looks correct. With it too high, the
 * kernel's `.hidden` beats the host's `.sm:inline` and its theme sublayer replaces the
 * app's fonts. Both states build green.
 *
 * The obvious check — "is `@layer mthds-form` named before `@layer theme`?" — does not
 * work, and that is not a style preference. It is a position check, and it PASSES in the
 * state where every control is invisible. Worse, lightningcss deletes the `@layer a, b;`
 * statement altogether and honours it by hoisting the blocks, so the names the source
 * writes never appear in the output to be read back.
 *
 * So this resolves the real thing: for a synthetic element, which declaration actually
 * wins one property — `!important`, then layer rank, then specificity, then document
 * order — and compares it against an expectation. Longhand and logical-property
 * expansion is built in, so `*{padding:0}` is correctly weighed against
 * `.px-5{padding-inline:…}`, a comparison a property-name diff misses.
 *
 * It reads only built bytes, so a toolchain change — lightningcss hoisting, a Tailwind
 * bump, a new mthds-ui sheet — is in scope by construction. What it cannot do is notice
 * a NEW kernel-only utility nobody asserts on; the CHECKS list is the contract, and it
 * is meant to be read and extended.
 *
 * It also checks the one input that makes the whole build lose classes without a word:
 * every `@source` in `src/index.css` must name a directory that exists, and one inside a
 * package must name the copy Node resolves. The console is a member of an npm workspace,
 * so its packages are hoisted to the repository root's `node_modules`; a path written
 * relative to the member resolved to nothing once, and Tailwind dropped `@alpic-ai/ui`'s
 * component classes while the build stayed green.
 *
 * Usage: node scripts/check-cascade.mjs [built.css]
 * With no argument it resolves the stylesheet from dist/assets/.vite/manifest.json,
 * so it never hardcodes a content hash. Run it after a build; `npm run check` does.
 */
import fs from "node:fs";
import path from "node:path";

// `no-console` is an error in this repo's eslint config, and this is a CLI whose whole
// output is its report. The repository's `scripts/smoke.ts` writes the same way.
const say = (text = "") => process.stdout.write(`${text}\n`);
const warn = (text) => process.stderr.write(`${text}\n`);

// ---------------------------------------------------------------- locate the stylesheet

const ROOT = path.resolve(import.meta.dirname, "..");

/**
 * The directory Node resolves a package to from the console, walking up the
 * `node_modules` directories the way its resolver does. In the workspace the install
 * hoists the console's packages to the repository root, so a path relative to this
 * package finds nothing, and both Tailwind and this check used to skip it silently.
 */
function packageDir(name) {
  for (let dir = ROOT; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return fs.realpathSync(candidate);
    if (path.dirname(dir) === dir) return undefined;
  }
}

function resolveStylesheet(argv) {
  if (argv) return argv;
  const manifestPath = path.join(ROOT, "dist/assets/.vite/manifest.json");
  if (!fs.existsSync(manifestPath)) {
    warn(
      `no build to check: ${path.relative(ROOT, manifestPath)} is missing.\n` +
        "Run `npm run build` first — this checks emitted bytes, not source.",
    );
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const entry = manifest["style.css"];
  if (!entry?.file) {
    warn("the build manifest has no `style.css` entry; the console's CSS entrypoint moved.");
    process.exit(2);
  }
  return path.join(ROOT, "dist/assets", entry.file);
}

// ------------------------------------------------------- depth-aware structural parser

/** Attribute every rule to its top-level layer, tracking brace depth and nesting. */
function parse(css) {
  const events = [];
  const rules = [];
  const stack = [];
  let i = 0;
  let buf = "";
  let bufStart = 0;
  const n = css.length;

  const topLayerOf = () => {
    for (const f of stack) if (f.kind === "layer") return f.names[0];
    return null;
  };
  const layerPathOf = () =>
    stack
      .filter((f) => f.kind === "layer")
      .map((f) => f.names.join("|"))
      .join(" > ") || "(unlayered)";

  while (i < n) {
    const c = css[i];
    if (c === "\\") {
      if (buf === "") bufStart = i;
      buf += css.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1;
      while (j < n && css[j] !== q) {
        if (css[j] === "\\") j++;
        j++;
      }
      buf += css.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "/" && css[i + 1] === "*") {
      const j = css.indexOf("*/", i + 2);
      i = j < 0 ? n : j + 2;
      continue;
    }
    if (c === "{") {
      const prelude = buf.trim();
      const preStart = bufStart;
      buf = "";
      bufStart = i + 1;
      if (/^@layer\b/i.test(prelude)) {
        const names = prelude
          .replace(/^@layer\s*/i, "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        events.push({ type: "layer-block", names, offset: preStart, depth: stack.length });
        stack.push({ kind: "layer", names, offset: preStart });
      } else if (/^@(media|supports|container|scope|document)\b/i.test(prelude)) {
        stack.push({ kind: "cond", prelude, offset: preStart });
      } else if (
        /^@(keyframes|font-face|property|page|counter-style|font-feature-values)\b/i.test(prelude)
      ) {
        stack.push({ kind: "atother", prelude, offset: preStart, selector: prelude });
      } else {
        stack.push({ kind: "rule", prelude, offset: preStart, selector: prelude });
      }
      i++;
      continue;
    }
    if (c === "}") {
      const top = stack[stack.length - 1];
      if (top && (top.kind === "rule" || top.kind === "atother")) {
        const decls = splitDecls(buf);
        if (decls.length) {
          rules.push({
            selector: top.selector,
            kind: top.kind,
            layerPath: layerPathOf(),
            topLayer: topLayerOf(),
            offset: top.offset,
            decls,
            conds: stack.filter((f) => f.kind === "cond").map((f) => f.prelude),
          });
        }
      }
      stack.pop();
      buf = "";
      bufStart = i + 1;
      i++;
      continue;
    }
    const inStatementPosition =
      stack.length === 0 ||
      stack[stack.length - 1].kind === "layer" ||
      stack[stack.length - 1].kind === "cond";
    if (c === ";" && inStatementPosition) {
      const stmt = buf.trim();
      if (/^@layer\b/i.test(stmt)) {
        const names = stmt
          .replace(/^@layer\s*/i, "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        events.push({ type: "layer-stmt", names, offset: bufStart, depth: stack.length });
      }
      buf = "";
      bufStart = i + 1;
      i++;
      continue;
    }
    if (buf === "") bufStart = i;
    buf += c;
    i++;
  }
  return { events, rules };
}

function splitDecls(text) {
  const out = [];
  let i = 0;
  let depth = 0;
  let cur = "";
  const push = (s) => {
    s = s.trim();
    if (!s) return;
    const k = s.indexOf(":");
    if (k < 0) return;
    out.push([s.slice(0, k).trim(), s.slice(k + 1).trim()]);
  };
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      cur += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1;
      while (j < text.length && text[j] !== q) {
        if (text[j] === "\\") j++;
        j++;
      }
      cur += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === ";" && depth === 0) {
      push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  push(cur);
  return out;
}

/** First-declaration order of top-level layer names — this IS the precedence order. */
function layerOrder(events) {
  const seen = new Map();
  for (const e of events) {
    if (e.depth !== 0) continue;
    for (const nm of e.names) if (!seen.has(nm)) seen.set(nm, { offset: e.offset, how: e.type });
  }
  return seen;
}

// ------------------------------------------------------------------- cascade resolution

/** Physical longhands, LTR / horizontal-tb, so shorthands and logical props compare. */
const EXPANSIONS = {
  padding: ["padding-top", "padding-right", "padding-bottom", "padding-left"],
  "padding-inline": ["padding-left", "padding-right"],
  "padding-block": ["padding-top", "padding-bottom"],
  "padding-inline-start": ["padding-left"],
  "padding-inline-end": ["padding-right"],
  "padding-block-start": ["padding-top"],
  "padding-block-end": ["padding-bottom"],
  margin: ["margin-top", "margin-right", "margin-bottom", "margin-left"],
  "margin-inline": ["margin-left", "margin-right"],
  "margin-block": ["margin-top", "margin-bottom"],
  "margin-inline-start": ["margin-left"],
  "margin-inline-end": ["margin-right"],
  "margin-block-start": ["margin-top"],
  "margin-block-end": ["margin-bottom"],
  border: [
    "border-top-width",
    "border-right-width",
    "border-bottom-width",
    "border-left-width",
    "border-top-style",
    "border-right-style",
    "border-bottom-style",
    "border-left-style",
    "border-top-color",
    "border-right-color",
    "border-bottom-color",
    "border-left-color",
  ],
  "border-width": [
    "border-top-width",
    "border-right-width",
    "border-bottom-width",
    "border-left-width",
  ],
  "border-color": [
    "border-top-color",
    "border-right-color",
    "border-bottom-color",
    "border-left-color",
  ],
  "border-radius": [
    "border-top-left-radius",
    "border-top-right-radius",
    "border-bottom-right-radius",
    "border-bottom-left-radius",
  ],
  background: ["background-color", "background-image"],
  font: ["font-family", "font-size", "font-weight", "font-style", "line-height"],
};
const expand = (p) => EXPANSIONS[p] || [p];

const unescape = (s) => s.replace(/\\(.)/g, "$1");

/** Match one compound selector against a synthetic element. Returns null for anything unmodelled. */
function matchCompound(sel, el) {
  sel = sel.trim();
  if (!sel) return false;
  if (/[\s>+~]/.test(sel.replace(/\\[\s>+~]/g, ""))) return null; // combinators: out of scope
  let rest = sel;
  let tag = null;
  const classes = new Set();
  const pseudos = new Set();
  const attrs = [];
  const tagMatch = rest.match(/^([*]|[a-zA-Z][\w-]*)/);
  if (tagMatch) {
    tag = tagMatch[1];
    rest = rest.slice(tagMatch[0].length);
  }
  while (rest.length) {
    let m;
    if ((m = rest.match(/^\.((?:[^.:[\\]|\\.)+)/))) {
      classes.add(unescape(m[1]));
      rest = rest.slice(m[0].length);
      continue;
    }
    if ((m = rest.match(/^\[([^\]]*)\]/))) {
      attrs.push(m[1]);
      rest = rest.slice(m[0].length);
      continue;
    }
    if ((m = rest.match(/^::?[\w-]+(\([^)]*\))?/))) {
      pseudos.add(m[0]);
      rest = rest.slice(m[0].length);
      continue;
    }
    return null;
  }
  if (tag && tag !== "*" && tag.toLowerCase() !== (el.tag || "").toLowerCase()) return false;
  for (const c of classes) if (!el.classes.includes(c)) return false;
  for (const a of attrs) if (!(el.attrs || []).includes(a.replace(/["']/g, ""))) return false;
  for (const p of pseudos) {
    if (p === ":root" || p === ":host") {
      if (!el.isRoot) return false;
      continue;
    }
    if (p.startsWith("::")) return false; // pseudo-element: a different box
    if (!(el.states || []).includes(p)) return false;
  }
  let b = classes.size + attrs.length;
  let c = tag && tag !== "*" ? 1 : 0;
  for (const p of pseudos) {
    if (p.startsWith("::")) c += 1;
    else b += 1;
  }
  return { spec: b * 100 + c };
}

function ruleMatch(rule, el) {
  let best = null;
  for (const part of rule.selector.split(",")) {
    const res = matchCompound(part, el);
    if (res && res.spec !== undefined && (!best || res.spec > best.spec)) best = res;
  }
  return best;
}

function condsHold(rule, el) {
  for (const c of rule.conds) {
    if (/^@media/i.test(c)) {
      const w = c.match(/width>=(\d+(?:\.\d+)?)rem/);
      if (w) {
        if ((el.viewport ?? 1280) < Number(w[1]) * 16) return false;
        continue;
      }
      return false; // unmodelled media query: treat as not applying
    }
    // The legacy @property polyfill guard. A modern engine skips it; `legacyEngine` opts in.
    if (/-webkit-hyphens:none/.test(c) || /-moz-orient:inline/.test(c))
      return el.legacyEngine === true;
  }
  return true;
}

function makeResolver(rules, order) {
  const rankOf = (layer) => (layer === null ? order.length : order.indexOf(layer));
  return function resolve(el, prop) {
    const physical = new Set(expand(prop));
    const candidates = [];
    for (const rule of rules) {
      if (rule.kind !== "rule") continue;
      if (!condsHold(rule, el)) continue;
      const m = ruleMatch(rule, el);
      if (!m) continue;
      for (const [p, v] of rule.decls) {
        if (!physical.has(p) && !expand(p).some((x) => physical.has(x))) continue;
        candidates.push({
          layer: rule.layerPath,
          rank: rankOf(rule.topLayer),
          spec: m.spec,
          offset: rule.offset,
          prop: p,
          value: v,
          important: /!important\s*$/.test(v) ? 1 : 0,
        });
      }
    }
    candidates.sort(
      (a, b) =>
        a.important - b.important || a.rank - b.rank || a.spec - b.spec || a.offset - b.offset,
    );
    return { winner: candidates[candidates.length - 1], all: candidates };
  };
}

// -------------------------------------------------------------------- the assertions

const el = (tag, classes, extra = {}) => ({ tag, classes, states: [], isRoot: false, ...extra });

// Class strings below are the kernel's own, from @pipelex/mthds-form/dist/react.
const INPUT = el("input", [
  "w-full",
  "rounded-md",
  "border",
  "border-border",
  "bg-input",
  "text-foreground",
  "px-3",
]);
const TEXTAREA = el("textarea", [
  "w-full",
  "rounded-md",
  "border",
  "border-border",
  "bg-input",
  "resize-y",
  "px-3",
]);
const SELECT_TRIGGER = el("button", [
  "flex",
  "w-full",
  "rounded-md",
  "border",
  "border-border",
  "bg-input",
  "px-3",
]);
const ENUM_ITEM = el("button", ["border-border", "bg-input", "px-3"], { attrs: ["data-state=on"] });
const SWITCH = el(
  "button",
  ["rounded-full", "data-[state=checked]:bg-primary", "data-[state=unchecked]:bg-input"],
  {
    attrs: ["data-state=checked"],
  },
);
const ENUM_ON = el("button", ["data-[state=on]:bg-primary/10"], { attrs: ["data-state=on"] });
const ROOT_EL = el("html", [], { isRoot: true });
const PLAIN_ROUNDED = el("div", ["rounded-md"]);
const RESPONSIVE = el("span", ["hidden", "sm:inline"], { viewport: 1280 });

/**
 * Spacing utilities the kernel's controls rely on. Some the host also generates and some
 * only the kernel has; which side wins is not the assertion. The assertion is that
 * preflight's `*{margin:0;padding:0}` does NOT, since that is what collapsed every
 * control to zero padding when `mthds-form` was ranked below `base`.
 */
const SPACING_SURVIVES_PREFLIGHT = [
  ["p-2.5", "padding-top"],
  ["px-5", "padding-left"],
  ["ps-3", "padding-left"],
  ["ps-5", "padding-left"],
  ["pr-12", "padding-right"],
  ["pb-1.5", "padding-bottom"],
  ["pt-px", "padding-top"],
  ["me-1.5", "margin-right"],
].map(([cls, prop]) => [
  `spacing survives preflight (.${cls})`,
  el("div", [cls]),
  prop,
  (v) => v !== "0",
]);

const CHECKS = [
  // --- the kernel must outrank the host's preflight (mthds-form above `base`) ---
  ["control surface (input.bg-input)", INPUT, "background-color", (v) => /var\(--input\)/.test(v)],
  [
    "control surface (textarea.bg-input)",
    TEXTAREA,
    "background-color",
    (v) => /var\(--input\)/.test(v),
  ],
  [
    "control surface (SelectTrigger button)",
    SELECT_TRIGGER,
    "background-color",
    (v) => /var\(--input\)/.test(v),
  ],
  [
    "segmented enum item surface",
    ENUM_ITEM,
    "background-color",
    (v) => /var\(--(color-)?(input|primary)\)/.test(v),
  ],
  [
    "switch track when checked",
    SWITCH,
    "background-color",
    (v) => /var\(--(color-)?primary\)/.test(v),
  ],
  ["segmented enum selected tint", ENUM_ON, "background-color", (v) => v !== "#0000"],
  ["control border width", INPUT, "border-top-width", (v) => v !== "0"],
  ["control border colour", INPUT, "border-top-color", (v) => /var\(--/.test(v)],
  ["control text colour", INPUT, "color", (v) => v !== "inherit"],
  ...SPACING_SURVIVES_PREFLIGHT,

  // --- the host must outrank the kernel for classes both sides define (below `utilities`) ---
  ["host radius wins on a plain div", PLAIN_ROUNDED, "border-radius", (v) => /--radius-md/.test(v)],
  ["responsive hidden/sm:inline at >=40rem", RESPONSIVE, "display", (v) => v === "inline"],

  // --- the app's fonts must survive the kernel's theme sublayer (pinned unlayered) ---
  ["app font token wins on :root", ROOT_EL, "--font-sans", (v) => /Inter/.test(v)],
  ["app mono token wins on :root", ROOT_EL, "--font-mono", (v) => /JetBrains/.test(v)],
];

// ------------------------------------------------------------------------------ run

const file = resolveStylesheet(process.argv[2]);
const css = fs.readFileSync(file, "utf8");
const { events, rules } = parse(css);
const order = [...layerOrder(events).keys()];
const resolve = makeResolver(rules, order);

say(`stylesheet: ${path.relative(ROOT, file)} (${css.length} bytes, ${rules.length} rules)`);
say(`layer order (weakest first): ${order.join(" < ")} < (unlayered)\n`);

let failures = 0;
const fail = (name, detail) => {
  failures++;
  say(`FAIL  ${name}`);
  for (const line of detail) say(`        ${line}`);
};

// Tailwind drops an `@source` that resolves to nothing without a word, so a wrong path
// shows up only as classes missing from the build. Check the paths themselves.
const indexCss = path.join(ROOT, "src/index.css");
for (const [, rel] of fs.readFileSync(indexCss, "utf8").matchAll(/^@source\s+"([^"]+)"\s*;/gm)) {
  const name = `@source "${rel}" names the directory the build reads`;
  const abs = path.resolve(path.dirname(indexCss), rel);
  if (!fs.existsSync(abs)) {
    fail(name, [
      `${path.relative(ROOT, abs)} does not exist, so Tailwind scanned nothing there.`,
      "The path is relative to src/index.css; the workspace hoists packages to the root node_modules.",
    ]);
    continue;
  }
  const pkg = rel.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1];
  const resolved = pkg === undefined ? undefined : packageDir(pkg);
  const real = fs.realpathSync(abs);
  const inside =
    resolved !== undefined && (real === resolved || real.startsWith(resolved + path.sep));
  if (pkg !== undefined && !inside) {
    fail(name, [`it names ${real}, but Node resolves ${pkg} to ${resolved ?? "nothing"}.`]);
    continue;
  }
  say(`PASS  ${name}`);
  say(`        -> ${path.relative(ROOT, abs)}`);
}

for (const [name, element, prop, ok] of CHECKS) {
  const { winner, all } = resolve(element, prop);
  const value = winner ? winner.value : "(no declaration matched)";
  if (winner && ok(value)) {
    say(`PASS  ${name}`);
    say(`        ${prop} -> ${value}`);
    say(
      `        from [${winner.layer}] @${winner.offset} (rank ${winner.rank}, spec ${winner.spec})`,
    );
    continue;
  }
  const detail = [`${prop} -> ${value}`];
  if (winner)
    detail.push(
      `from [${winner.layer}] @${winner.offset} (rank ${winner.rank}, spec ${winner.spec})`,
    );
  detail.push("candidates, weakest first:");
  for (const c of all.slice(-6)) {
    detail.push(
      `  [${c.layer}] @${c.offset} ${c.prop}: ${c.value.slice(0, 64)}  rank=${c.rank} spec=${c.spec}`,
    );
  }
  fail(name, detail);
}

// `properties` holds Tailwind's @property fallback for engines without native support.
// Promoting it resets every --tw-* there, breaking shadows, rings and transforms — a
// failure no browser on this machine can show, so it is asserted rather than observed.
if (order.includes("properties") && order.includes("utilities")) {
  const ok = order.indexOf("properties") < order.indexOf("utilities");
  if (ok) say("PASS  @property fallback layer ranks below utilities");
  else
    fail("@property fallback layer ranks below utilities", [
      `properties is at rank ${order.indexOf("properties")}, utilities at ${order.indexOf("utilities")}`,
      "On an engine without native @property this resets every --tw-* custom property.",
    ]);
}

// src/index.css pins --font-sans / --font-mono unlayered, because the kernel's theme
// sublayer would otherwise take them wherever mthds-form sits. A pinned literal goes
// stale in silence, so assert it still matches the theme package it was copied from.
const alpicDir = packageDir("@alpic-ai/ui");
const alpicTokens = alpicDir && path.join(alpicDir, "src/styles/tokens.css");
if (!alpicTokens || !fs.existsSync(alpicTokens)) {
  fail("the pinned font tokens can be compared with @alpic-ai/ui", [
    alpicDir
      ? `${alpicTokens} is missing: @alpic-ai/ui moved its tokens.`
      : "@alpic-ai/ui does not resolve from the console.",
  ]);
} else {
  const src = fs.readFileSync(alpicTokens, "utf8");
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  for (const token of ["--font-sans", "--font-mono"]) {
    const declared = src.match(new RegExp(`${token}\\s*:\\s*([^;]+);`));
    const { winner } = resolve(ROOT_EL, token);
    if (!declared || !winner) {
      fail(`${token} tracks @alpic-ai/ui`, [
        declared
          ? "no winning declaration in the build"
          : "not declared in @alpic-ai/ui tokens.css",
      ]);
      continue;
    }
    if (norm(declared[1]) === norm(winner.value)) {
      say(`PASS  ${token} matches @alpic-ai/ui's own tokens.css`);
    } else {
      fail(`${token} matches @alpic-ai/ui's own tokens.css`, [
        `alpic declares: ${norm(declared[1])}`,
        `the build resolves: ${norm(winner.value)}`,
        "The pinned copy in src/index.css has drifted; update it to alpic's value.",
      ]);
    }
  }
}

say(`\n${failures === 0 ? "ALL CASCADE CHECKS PASS" : `${failures} CASCADE CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
