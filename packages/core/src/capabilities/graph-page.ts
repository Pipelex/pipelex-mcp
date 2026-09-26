import { promises as fs } from "node:fs";
import type { Stats } from "node:fs";
import path from "node:path";

import { asOneLine } from "./shared.js";
import type { ToolError } from "./shared.js";
import { errorMessage, isInsideRoot, isMissingPathError } from "./workspace-boundary.js";

/**
 * The method graph page: a standalone HTML file `mthds_validate` writes beside
 * the `.mthds` files it was given as `{ path }`, so a builder whose host renders
 * no views can still see the method's flowchart by opening it in a browser.
 *
 * The page carries the method's SOURCES, not a graph. `@pipelex/mthds-ui`'s
 * standalone viewer bundle reads them from an embedded `mthds-sources` element
 * and builds the static graph in the browser, the way a Mermaid page carries
 * its diagram text and loads the renderer. So drawing it costs no API call and
 * no install, and the page is right whatever the validation verdict was: a
 * method that does not parse still draws what it can, with the builder's notes
 * on the viewer's toolbar. The contract is mthds-ui's `docs/static-graph.md`,
 * "Drawing a method in a standalone page".
 *
 * The viewer and elkjs load from jsDelivr, pinned by exact version and by
 * Subresource Integrity, so the page keeps drawing the same way and the browser
 * refuses a file that changed. Nothing of mthds-ui is vendored into the
 * workshop's tarball, which is why the page needs a connection to draw.
 *
 * The write policy is `mthds_codegen`'s, not `mthds_download_artifacts`': the
 * page is regenerated on every validation and must land on the same name, so it
 * overwrites a page it can prove it wrote (the generator mark below) and
 * nothing else. A symlink, a directory or a file without the mark at that name
 * is somebody else's, and is left untouched. Containment is the shared
 * workspace boundary; policy is this module's alone, per
 * `workspace-boundary.ts`.
 *
 * Every failure is a returned value, never a throw: a page that could not be
 * written is reported beside the verdict, and never changes it.
 */

export const GRAPH_PAGE_FILENAME = "method-graph.html";

/** A file the page loads, pinned by URL and by the hash the browser checks it against. */
export interface PinnedAsset {
  url: string;
  integrity: string;
}

const CDN = "https://cdn.jsdelivr.net/npm";

/**
 * The viewer build the page loads. It is the first `@pipelex/mthds-ui` release
 * whose standalone bundle reads the `mthds-sources` embed, and the embed
 * writer below follows that release's contract. Moving it means moving the
 * three hashes with it (`graph-page.e2e.ts` fetches the files and checks them)
 * and re-reading the embed contract for the new version.
 */
export const GRAPH_VIEWER_VERSION = "0.25.0";

/** The layout engine the standalone viewer expects as a global, at the version mthds-ui depends on. */
export const ELKJS_VERSION = "0.11.1";

export const GRAPH_PAGE_ASSETS = {
  viewerStylesheet: {
    url: `${CDN}/@pipelex/mthds-ui@${GRAPH_VIEWER_VERSION}/dist/standalone/graph-viewer.css`,
    integrity: "sha384-28wM4YgT7W2uUld6tPfYbX+a/7+SU8f8Ax8hh33ai+twYehLegCV9004Jc6iFCoj",
  },
  elkScript: {
    url: `${CDN}/elkjs@${ELKJS_VERSION}/lib/elk.bundled.js`,
    integrity: "sha384-k7OFwtsMfFyYU75zZhPkC8VRASnGrW1pxavUnozOiO2B5M5gv6PYGOkEYZTrVtvo",
  },
  viewerScript: {
    url: `${CDN}/@pipelex/mthds-ui@${GRAPH_VIEWER_VERSION}/dist/standalone/graph-viewer.js`,
    integrity: "sha384-60WI1qFjHBdbY7xo4/3TSjYc1pyLOoXGtauipAZcPn02h/ilZ27cfM8VguIhAXCQ",
  },
} as const satisfies Record<string, PinnedAsset>;

/** The viewer's `pipelex-config` embed: the graph top to bottom, every controller shown. */
const VIEWER_CONFIG = {
  direction: "TB",
  foldMode: "expanded",
  showControllers: true,
  theme: "system",
} as const;

/**
 * The mark that makes a page this tool's own. It is a standard `generator`
 * meta element, so it says who wrote the file to anyone reading it, and it sits
 * at the top of the head, well inside {@link HEAD_BYTES}. It carries no
 * version: a page written by an older workshop is still this tool's to replace.
 */
export const GRAPH_PAGE_MARK = '<meta name="generator" content="@pipelex/mcp method-graph">';

/** Only the head of an existing file is read: a foreign file is never loaded whole just to be refused. */
const HEAD_BYTES = 1024;

/** One `.mthds` file as the embed carries it: its name relative to the page, and its text. */
export interface MethodSource {
  name: string;
  content: string;
}

/**
 * The text of the page's `mthds-sources` element: a JSON array of
 * `{ name, content }`, with every `<` written as `<` so that no method
 * text — a prompt quoting `</script>`, or a `<!--` — can end the element early
 * or change how the HTML parser tokenizes it. JSON reads the escape back as
 * `<`. Escaping every `<`, rather than matching `</script>`, is what makes it
 * hold: the parser also ends the element on `</script ` and `</script/`, in any
 * case.
 *
 * A one-function mirror of `@pipelex/mthds-ui/static-graph`'s export of the
 * same name, which checks the same contract. The workshop does not import it
 * because declaring `@pipelex/mthds-ui` in the workshop's manifest, even as a
 * devDependency the build inlines, would force the console onto the same range
 * (`tests/workspace-manifests.test.ts` holds one range per package), and the
 * release carrying the export changes the console's stylesheet contract. The
 * contract is public and documented for hosts that write the element
 * themselves; once the console is on that release, this becomes an import.
 *
 * Throws on a list the viewer would refuse, since only a programming error
 * here can produce one: {@link writeGraphPage} names every file itself.
 */
export function serializeMthdsSourcesEmbed(sources: readonly MethodSource[]): string {
  if (sources.length === 0) {
    throw new Error("The mthds-sources embed needs at least one file.");
  }
  const names = new Set<string>();
  for (const source of sources) {
    if (source.name === "") {
      throw new Error("Every file in the mthds-sources embed needs a name.");
    }
    if (names.has(source.name)) {
      throw new Error(`The mthds-sources embed names ${source.name} twice.`);
    }
    names.add(source.name);
  }
  return escapeForScriptElement(
    JSON.stringify(sources.map(({ name, content }) => ({ name, content }))),
  );
}

function escapeForScriptElement(json: string): string {
  return json.replaceAll("<", "\\u003c");
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function stylesheetTag(asset: PinnedAsset): string {
  return `<link rel="stylesheet" href="${asset.url}" integrity="${asset.integrity}" crossorigin="anonymous">`;
}

function scriptTag(asset: PinnedAsset): string {
  return `<script src="${asset.url}" integrity="${asset.integrity}" crossorigin="anonymous"></script>`;
}

/**
 * The whole page. `#root` inside `#app-container` is where the viewer mounts,
 * and `graph-viewer.css` sizes the container to the window. What `#root` holds
 * until then is what a reader sees when the viewer never arrives — offline, or
 * a CDN file that failed its integrity check — since mounting replaces it.
 */
export function renderGraphPage(title: string, sources: readonly MethodSource[]): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${GRAPH_PAGE_MARK}
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- Written by mthds_validate, the Pipelex plugin's MCP server, from the .mthds files embedded below. Each validation of those files rewrites it, so an edit made here does not last. -->
<title>${escapeHtml(title)}</title>
${stylesheetTag(GRAPH_PAGE_ASSETS.viewerStylesheet)}
</head>
<body>
<div id="app-container"><div id="root"><p style="font-family: system-ui, sans-serif; margin: 2rem;">Loading the method graph. This page loads its viewer from cdn.jsdelivr.net, so it needs a network connection.</p></div></div>
<script type="application/json" id="mthds-sources">${serializeMthdsSourcesEmbed(sources)}</script>
<script type="application/json" id="pipelex-config">${escapeForScriptElement(JSON.stringify(VIEWER_CONFIG))}</script>
${scriptTag(GRAPH_PAGE_ASSETS.elkScript)}
${scriptTag(GRAPH_PAGE_ASSETS.viewerScript)}
</body>
</html>
`;
}

/** A `.mthds` file as `mthds_validate` read it: the path it was given, relative to the working directory, and the text validated. */
export interface GraphPageFile {
  path: string;
  content: string;
}

/**
 * What became of the page. `path` is where it is, or would have been, relative
 * to the working directory; `created` distinguishes a first write from a
 * rewrite, for the summary alone; `error` says why nothing was written.
 */
export interface GraphPageOutcome {
  path: string;
  written: boolean;
  created?: boolean;
  error?: ToolError;
}

/**
 * Write the page for `files` into the directory that holds them — the deepest
 * directory holding them all, when they span several, with each embedded name
 * relative to it.
 *
 * Every directory is taken on its REAL path, and the file names as given, so
 * the page lands beside the files where the caller named them even through a
 * symlinked directory, and is contained against the real working directory.
 * The files were read through the workshop's resolver, which already contained
 * them; this checks again because it is the write side.
 */
export async function writeGraphPage(
  saveRoot: string,
  files: readonly GraphPageFile[],
): Promise<GraphPageOutcome> {
  let root: string;
  try {
    root = await fs.realpath(saveRoot);
  } catch (err) {
    return {
      path: GRAPH_PAGE_FILENAME,
      written: false,
      error: {
        class: "config",
        location: "deployment",
        message: `Could not resolve the server's working directory: ${errorMessage(err)}`,
        hint: `The local workshop writes the method graph page under its working directory (${saveRoot}), which must exist.`,
        retryable: false,
      },
    };
  }

  const located: { dir: string; file: string; content: string }[] = [];
  for (const file of files) {
    let dir: string;
    try {
      dir = await fs.realpath(path.dirname(path.resolve(root, file.path)));
    } catch (err) {
      return notWritten(GRAPH_PAGE_FILENAME, {
        class: "runtime",
        location: "graph_page",
        message: `Could not resolve the directory of ${file.path}: ${errorMessage(err)}`,
        hint: "Validate again once the file is back in place, or pass graph_page: false.",
        retryable: true,
      });
    }
    if (!isInsideRoot(root, dir)) {
      return notWritten(GRAPH_PAGE_FILENAME, {
        class: "input_domain",
        location: "graph_page",
        message: `The directory of ${file.path} resolves outside the server's working directory.`,
        hint: `The method graph page is written only inside the directory the host started this server in (${root}).`,
        retryable: false,
      });
    }
    located.push({ dir, file: path.basename(file.path), content: file.content });
  }

  const pageDir = deepestCommonDirectory(located.map(({ dir }) => dir));
  const pagePath = path.join(pageDir, GRAPH_PAGE_FILENAME);
  const reported = path.relative(root, pagePath);

  // One entry per file NAME: the same file submitted twice (`a.mthds` and
  // `./a.mthds`) is validated twice but drawn once, where the viewer would
  // refuse the repeated name outright.
  const sources: MethodSource[] = [];
  const seen = new Set<string>();
  for (const { dir, file, content } of located) {
    const name = path.relative(pageDir, path.join(dir, file)).split(path.sep).join("/");
    if (seen.has(name)) continue;
    seen.add(name);
    sources.push({ name, content });
  }
  const title = `${path.basename(pageDir)} — method graph`;
  const page = renderGraphPage(title, sources);

  const inspection = await inspectPage(pagePath);
  if (inspection.kind === "error") {
    return notWritten(reported, inspection.error);
  }
  if (inspection.kind === "foreign") {
    return notWritten(reported, {
      class: "input_domain",
      location: "graph_page",
      message: `${reported} is already there and was not written by this tool (${inspection.reason}), so it was left untouched.`,
      hint: "Rename or move that file to get the method graph page there, or pass graph_page: false to stop writing it.",
      retryable: false,
    });
  }

  const created = inspection.kind === "missing";
  try {
    // A new page is created exclusively, so a file that appeared since the
    // inspection is refused rather than replaced; only a page proven to be
    // this tool's is overwritten.
    await fs.writeFile(pagePath, page, { encoding: "utf8", flag: created ? "wx" : "w" });
  } catch (err) {
    const appeared = (err as NodeJS.ErrnoException).code === "EEXIST";
    return notWritten(reported, {
      class: "runtime",
      location: "graph_page",
      message: appeared
        ? `${reported} appeared while the method graph page was being written, so it was left untouched.`
        : `Could not write ${reported}: ${errorMessage(err)}`,
      hint: appeared
        ? "Validate again to write the page, or pass graph_page: false."
        : "Check that the directory holding the .mthds files is writable, or pass graph_page: false.",
      retryable: appeared,
    });
  }
  return { path: reported, written: true, created };
}

function notWritten(reported: string, error: ToolError): GraphPageOutcome {
  return { path: reported, written: false, error };
}

/** The deepest directory that is, or holds, every one of `dirs` (absolute, real paths). */
export function deepestCommonDirectory(dirs: readonly string[]): string {
  let common = dirs[0] ?? path.sep;
  for (const dir of dirs.slice(1)) {
    while (!isInsideRoot(common, dir)) {
      const parent = path.dirname(common);
      if (parent === common) return common;
      common = parent;
    }
  }
  return common;
}

type Inspection =
  | { kind: "missing" }
  | { kind: "owned" }
  | { kind: "foreign"; reason: string }
  | { kind: "error"; error: ToolError };

/**
 * `lstat`, not `stat`: overwriting through a symlink writes wherever it points,
 * so a symlink at the page's name is foreign by construction.
 */
async function inspectPage(absolute: string): Promise<Inspection> {
  let stats: Stats;
  try {
    stats = await fs.lstat(absolute);
  } catch (err) {
    if (isMissingPathError(err)) {
      return { kind: "missing" };
    }
    return { kind: "error", error: inspectionError(absolute, err) };
  }

  if (stats.isSymbolicLink()) {
    return { kind: "foreign", reason: "it is a symlink" };
  }
  if (!stats.isFile()) {
    return { kind: "foreign", reason: "it is not a regular file" };
  }

  let head: string;
  try {
    head = await readHead(absolute);
  } catch (err) {
    return { kind: "error", error: inspectionError(absolute, err) };
  }
  return head.includes(GRAPH_PAGE_MARK)
    ? { kind: "owned" }
    : { kind: "foreign", reason: "it does not carry this tool's generator mark" };
}

function inspectionError(absolute: string, err: unknown): ToolError {
  return {
    class: "runtime",
    location: "graph_page",
    message: `Could not inspect the existing ${path.basename(absolute)}: ${errorMessage(err)}`,
    hint: "Check the directory's permissions, then validate again, or pass graph_page: false.",
    retryable: true,
  };
}

/** Decoded leniently: the test is a substring match, so a binary file simply fails to match. */
async function readHead(absolute: string): Promise<string> {
  const handle = await fs.open(absolute, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * The page's section in the validation summary. A first write says what the
 * file is, since the user did not ask for it by name and it is new in their
 * tree; a rewrite only says where it is. A page that was not written says why,
 * and that the verdict above it stands.
 */
export function graphPageSection(outcome: GraphPageOutcome): string {
  const where = `\`${asOneLine(outcome.path)}\``;
  if (!outcome.written) {
    const reason = outcome.error === undefined ? "" : ` ${asOneLine(outcome.error.message)}`;
    const hint =
      outcome.error?.hint === undefined ? "" : `\n\n*Hint: ${asOneLine(outcome.error.hint)}*`;
    return `## Method graph\n\nThe method's flowchart page was not written to ${where}; the verdict above stands.${reason}${hint}`;
  }
  if (outcome.created === true) {
    return (
      `## Method graph\n\nWrote the method's flowchart to ${where}, a standalone page that draws the graph when opened in a browser ` +
      "(its viewer loads from cdn.jsdelivr.net). Each validation of these files rewrites it. " +
      "It is a generated file, so a project under version control may want it ignored."
    );
  }
  return `## Method graph\n\nRewrote the method's flowchart at ${where}: open it in a browser to see the graph.`;
}
