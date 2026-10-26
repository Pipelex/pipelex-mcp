import { constants as fsConstants, promises as fs } from "node:fs";
import type { Stats } from "node:fs";
import path from "node:path";

import { MTHDS_SOURCES_EMBED_ID, serializeMthdsSourcesEmbed } from "@pipelex/mthds-ui/static-graph";
import type { MthdsSource } from "@pipelex/mthds-ui/static-graph";

import { buildProblem } from "@pipelex/sdk";
import type { CoreErrorCode, ProblemParamsByCode } from "@pipelex/sdk";

import { asOneLine } from "./shared.js";
import type { Problem } from "./shared.js";
import {
  deepestCommonDirectory,
  errorMessage,
  isInsideRoot,
  isMissingPathError,
} from "./workspace-boundary.js";

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
 * refuses a file that changed. Of mthds-ui, only the embed serializer from
 * `@pipelex/mthds-ui/static-graph` is inlined into the workshop's
 * `dist/main.js`; the viewer and elkjs are not in the tarball, which is why
 * the page needs a connection to draw.
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
 * The viewer build the page loads, which must be the `@pipelex/mthds-ui`
 * version this repository installs: the page's `mthds-sources` element is
 * written by that version's `serializeMthdsSourcesEmbed`, and the viewer at the
 * same version is the reader that function is kept in step with. Moving it
 * means moving the viewer's two hashes with it. `graph-page.test.ts` checks the
 * version and both hashes against the installed package, and
 * `graph-page.e2e.ts` checks the hashes against the files jsDelivr serves.
 */
export const GRAPH_VIEWER_VERSION = "0.27.0";

/** The layout engine the standalone viewer expects as a global, at the version mthds-ui depends on. */
export const ELKJS_VERSION = "0.11.1";

export const GRAPH_PAGE_ASSETS = {
  viewerStylesheet: {
    url: `${CDN}/@pipelex/mthds-ui@${GRAPH_VIEWER_VERSION}/dist/standalone/graph-viewer.css`,
    integrity: "sha384-gslj/GPu4dd1j4bHBlsw9gyFQ5KBD2yWs2t73E8/tsUAaWkEEWUmQ63wrrAz+BPe",
  },
  elkScript: {
    url: `${CDN}/elkjs@${ELKJS_VERSION}/lib/elk.bundled.js`,
    integrity: "sha384-k7OFwtsMfFyYU75zZhPkC8VRASnGrW1pxavUnozOiO2B5M5gv6PYGOkEYZTrVtvo",
  },
  viewerScript: {
    url: `${CDN}/@pipelex/mthds-ui@${GRAPH_VIEWER_VERSION}/dist/standalone/graph-viewer.js`,
    integrity: "sha384-Ph9EyLtFeVH9JZxAqjGrGsbL9V5lHlOuxeTrlQgK0DDPkt/8M55DkTlR5Qb53lS6",
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

/**
 * JSON made safe inside a `<script>` element: every `<` written as `\u003c`,
 * which JSON reads back as `<`, so no text can end the element early, whatever
 * spelling of `</script` it uses, or open a `<!--`. The `mthds-sources` element
 * gets the same escape from mthds-ui's serializer.
 */
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
export function renderGraphPage(title: string, sources: readonly MthdsSource[]): string {
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
<script type="application/json" id="${MTHDS_SOURCES_EMBED_ID}">${serializeMthdsSourcesEmbed(sources)}</script>
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
 * rewrite, for the summary alone; `error` says why nothing was written, as
 * the problem of a write the workshop refused or could not make, located at
 * `graph_page`.
 */
export interface GraphPageOutcome {
  path: string;
  written: boolean;
  created?: boolean;
  error?: Problem;
}

/**
 * The problem of a page not written, located at `graph_page`, the argument
 * that turns the page off, with the workshop's own sentence and what to do as
 * its `message`.
 */
function pageProblem<Code extends CoreErrorCode>(
  code: Code,
  params: ProblemParamsByCode[Code],
  message: string,
  remedy: string,
): Problem {
  return buildProblem(code, params, {
    location: { field: "graph_page" },
    extra: { message: `${message} ${remedy}` },
  });
}

/** Why a file operation failed, as the system's error code, or `unreadable`. */
function systemReason(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && code !== "" ? code : "unreadable";
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
      error: buildProblem(
        "client.not_configured",
        { setting: "working_directory" },
        {
          extra: {
            message: `Could not resolve the server's working directory: ${errorMessage(err)} The local workshop writes the method graph page under its working directory (${saveRoot}), which must exist.`,
          },
        },
      ),
    };
  }

  const located: { dir: string; file: string; content: string }[] = [];
  for (const file of files) {
    let dir: string;
    try {
      dir = await fs.realpath(path.dirname(path.resolve(root, file.path)));
    } catch (err) {
      return notWritten(
        GRAPH_PAGE_FILENAME,
        pageProblem(
          "client.workspace_busy",
          { path: file.path },
          `Could not resolve the directory of ${file.path}: ${errorMessage(err)}`,
          "Validate again once the file is back in place, or pass graph_page: false.",
        ),
      );
    }
    if (!isInsideRoot(root, dir)) {
      return notWritten(
        GRAPH_PAGE_FILENAME,
        pageProblem(
          "client.argument_invalid",
          { argument: "graph_page", reason: "outside_workspace" },
          `The directory of ${file.path} resolves outside the server's working directory.`,
          `The method graph page is written only inside the directory the host started this server in (${root}).`,
        ),
      );
    }
    located.push({ dir, file: path.basename(file.path), content: file.content });
  }

  const pageDir = deepestCommonDirectory(located.map(({ dir }) => dir));
  const pagePath = path.join(pageDir, GRAPH_PAGE_FILENAME);
  const reported = path.relative(root, pagePath);

  // One entry per file NAME: the same file submitted twice (`a.mthds` and
  // `./a.mthds`) is validated twice but drawn once, where the viewer would
  // refuse the repeated name outright.
  const sources: MthdsSource[] = [];
  const seen = new Set<string>();
  for (const { dir, file, content } of located) {
    const name = path.relative(pageDir, path.join(dir, file)).split(path.sep).join("/");
    if (seen.has(name)) continue;
    seen.add(name);
    sources.push({ name, content });
  }
  const title = `${path.basename(pageDir)} — method graph`;
  const page = renderGraphPage(title, sources);

  const inspection = await inspectPage(pagePath, reported);
  if (inspection.kind === "error") {
    return notWritten(reported, inspection.error);
  }
  if (inspection.kind === "foreign") {
    return notWritten(
      reported,
      pageProblem(
        "client.target_exists",
        { path: reported },
        `${reported} is already there and was not written by this tool (${inspection.reason}), so it was left untouched.`,
        "Rename or move that file to get the method graph page there, or pass graph_page: false to stop writing it.",
      ),
    );
  }

  const created = inspection.kind === "missing";
  try {
    // A new page is created exclusively, so a file that appeared since the
    // inspection is refused rather than replaced; only a page proven to be
    // this tool's is overwritten.
    await fs.writeFile(pagePath, page, { encoding: "utf8", flag: created ? "wx" : "w" });
  } catch (err) {
    const appeared = (err as NodeJS.ErrnoException).code === "EEXIST";
    return notWritten(
      reported,
      appeared
        ? pageProblem(
            "client.workspace_busy",
            { path: reported },
            `${reported} appeared while the method graph page was being written, so it was left untouched.`,
            "Validate again to write the page, or pass graph_page: false.",
          )
        : pageProblem(
            "client.write_failed",
            { path: reported, reason: systemReason(err) },
            `Could not write ${reported}: ${errorMessage(err)}`,
            "Check that the directory holding the .mthds files is writable, or pass graph_page: false.",
          ),
    );
  }
  return { path: reported, written: true, created };
}

function notWritten(reported: string, error: Problem): GraphPageOutcome {
  return { path: reported, written: false, error };
}

type Inspection =
  | { kind: "missing" }
  | { kind: "owned" }
  | { kind: "foreign"; reason: string }
  | { kind: "error"; error: Problem };

/**
 * `lstat`, not `stat`: overwriting through a symlink writes wherever it points,
 * so a symlink at the page's name is foreign by construction.
 */
async function inspectPage(absolute: string, reported: string): Promise<Inspection> {
  let stats: Stats;
  try {
    stats = await fs.lstat(absolute);
  } catch (err) {
    if (isMissingPathError(err)) {
      return { kind: "missing" };
    }
    return { kind: "error", error: inspectionError(absolute, reported, err) };
  }

  if (stats.isSymbolicLink()) {
    return { kind: "foreign", reason: "it is a symlink" };
  }
  if (!stats.isFile()) {
    return { kind: "foreign", reason: "it is not a regular file" };
  }

  let owned: boolean;
  try {
    owned = await carriesGraphPageMark(absolute);
  } catch (err) {
    return { kind: "error", error: inspectionError(absolute, reported, err) };
  }
  return owned
    ? { kind: "owned" }
    : { kind: "foreign", reason: "it does not carry this tool's generator mark" };
}

function inspectionError(absolute: string, reported: string, err: unknown): Problem {
  return pageProblem(
    "client.file_unreadable",
    { path: reported, reason: systemReason(err) },
    `Could not inspect the existing ${path.basename(absolute)}: ${errorMessage(err)}`,
    "Check the directory's permissions, then validate again, or pass graph_page: false.",
  );
}

// Neither flag exists on Windows, where the caller's own `lstat` is the only guard.
const HEAD_READ_FLAGS =
  fsConstants.O_RDONLY |
  ((fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0) |
  ((fsConstants as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0);

/**
 * Whether the file at `absolute` is this tool's page: whether its head
 * carries {@link GRAPH_PAGE_MARK}. The one ownership test, asked by the writer
 * before it replaces a page and by `method-tree.ts` before it leaves a page
 * out of a method's tree. The file is opened without following a link, and
 * only its first {@link HEAD_BYTES} are read, decoded leniently, so a binary
 * file simply fails to match. Throws when the file cannot be read.
 */
export async function carriesGraphPageMark(absolute: string): Promise<boolean> {
  const handle = await fs.open(absolute, HEAD_READ_FLAGS);
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8").includes(GRAPH_PAGE_MARK);
  } finally {
    await handle.close();
  }
}

/**
 * The page's section in the validation summary. A first write says what the
 * file is, since the user did not ask for it by name and it is new in their
 * tree; a rewrite only says where it is. A page that was not written says why,
 * and that the result above it is unaffected: the verdict, when the API
 * produced one, and otherwise the errors, since saying a verdict stands where
 * none exists would invite the model to report one.
 */
/** The sentence a page's problem says itself with: the workshop's own `message`, else its detail. */
function pageProblemText(problem: Problem): string {
  const message: unknown = problem.message;
  return typeof message === "string" && message !== "" ? message : problem.detail;
}

export function graphPageSection(outcome: GraphPageOutcome, verdictProduced: boolean): string {
  const where = `\`${asOneLine(outcome.path)}\``;
  if (!outcome.written) {
    const unaffected = verdictProduced
      ? "the verdict above stands"
      : "the result above is unaffected";
    const reason =
      outcome.error === undefined ? "" : ` ${asOneLine(pageProblemText(outcome.error))}`;
    const code = outcome.error === undefined ? "" : ` (\`${outcome.error.code}\`)`;
    return `## Method graph\n\nThe method's flowchart page was not written to ${where}; ${unaffected}.${reason}${code}`;
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
