import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  GRAPH_PAGE_ASSETS,
  GRAPH_PAGE_FILENAME,
  GRAPH_PAGE_MARK,
  deepestCommonDirectory,
  graphPageSection,
  renderGraphPage,
  serializeMthdsSourcesEmbed,
  writeGraphPage,
} from "./graph-page.js";
import type { GraphPageOutcome, MethodSource } from "./graph-page.js";

/**
 * The writer runs against real `mkdtemp` working directories: what it
 * contains, creates, replaces and refuses is decided on a real filesystem,
 * symlinks included, and a fake would only restate the code.
 */

/** Permission-driven cases cannot bite as root, so they are skipped there rather than made vacuous. */
const asRoot = process.getuid?.() === 0;

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pipelex-graph-page-")));
  tempDirs.push(dir);
  return dir;
}

/** Write each file under `root` and return them in the shape `mthds_validate` hands the writer. */
async function placeFiles(root: string, files: Record<string, string>) {
  const placed = [];
  for (const [relative, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), content, "utf8");
    placed.push({ path: relative, content });
  }
  return placed;
}

/** The parsed `mthds-sources` embed of a page, read back the way the viewer reads it. */
function embeddedSources(page: string): unknown {
  const match = /<script type="application\/json" id="mthds-sources">([\s\S]*?)<\/script>/.exec(
    page,
  );
  if (match?.[1] === undefined) {
    throw new Error("the page carries no mthds-sources element");
  }
  return JSON.parse(match[1]);
}

const BUNDLE = 'domain = "demo"\nmain_pipe = "main"\n';

describe("serializeMthdsSourcesEmbed", () => {
  it("escapes every less-than sign, so no method text can end the element", () => {
    const sources: MethodSource[] = [
      {
        name: "bundle.mthds",
        content: 'prompt = "</script><script>alert(1)</script> <!-- </SCRIPT > </script/"',
      },
    ];
    const embed = serializeMthdsSourcesEmbed(sources);

    expect(embed).not.toContain("<");
    expect(JSON.parse(embed)).toEqual(sources);
  });

  it("keeps only the name and the content", () => {
    const embed = serializeMthdsSourcesEmbed([
      { name: "bundle.mthds", content: BUNDLE, extra: "dropped" } as MethodSource,
    ]);

    expect(JSON.parse(embed)).toEqual([{ name: "bundle.mthds", content: BUNDLE }]);
  });

  it("refuses a list the viewer would refuse", () => {
    expect(() => serializeMthdsSourcesEmbed([])).toThrow(/at least one file/);
    expect(() => serializeMthdsSourcesEmbed([{ name: "", content: BUNDLE }])).toThrow(/a name/);
    expect(() =>
      serializeMthdsSourcesEmbed([
        { name: "bundle.mthds", content: BUNDLE },
        { name: "bundle.mthds", content: BUNDLE },
      ]),
    ).toThrow(/twice/);
  });
});

describe("renderGraphPage", () => {
  const page = renderGraphPage("demo & <co> — method graph", [
    { name: "bundle.mthds", content: BUNDLE },
  ]);

  it("loads every CDN file pinned by version and integrity", () => {
    for (const asset of Object.values(GRAPH_PAGE_ASSETS)) {
      // An exact version, never a range or a tag: the hash pins one file.
      expect(asset.url).toMatch(
        /^https:\/\/cdn\.jsdelivr\.net\/npm\/(@[^/]+\/)?[^/@]+@\d+\.\d+\.\d+\//,
      );
      expect(asset.integrity).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/);
      expect(page).toContain(
        `"${asset.url}" integrity="${asset.integrity}" crossorigin="anonymous"`,
      );
    }
    // elkjs must be a global before the viewer bundle runs.
    expect(page.indexOf(GRAPH_PAGE_ASSETS.elkScript.url)).toBeLessThan(
      page.indexOf(GRAPH_PAGE_ASSETS.viewerScript.url),
    );
  });

  it("carries the generator mark in the head the writer reads back", () => {
    expect(page.indexOf(GRAPH_PAGE_MARK)).toBeGreaterThan(-1);
    expect(Buffer.byteLength(page.slice(0, page.indexOf(GRAPH_PAGE_MARK)))).toBeLessThan(512);
  });

  it("mounts where the viewer looks and embeds the sources and the config", () => {
    expect(page).toContain('<div id="app-container"><div id="root">');
    expect(embeddedSources(page)).toEqual([{ name: "bundle.mthds", content: BUNDLE }]);
    expect(page).toContain('<script type="application/json" id="pipelex-config">{');
  });

  it("escapes the title as HTML", () => {
    expect(page).toContain("<title>demo &amp; &lt;co&gt; — method graph</title>");
  });
});

describe("deepestCommonDirectory", () => {
  it("is the directory itself when there is one, and the shared ancestor otherwise", () => {
    const base = path.join(path.sep, "work", "methods");
    expect(deepestCommonDirectory([base, base])).toBe(base);
    expect(deepestCommonDirectory([base, path.join(base, "sub")])).toBe(base);
    expect(deepestCommonDirectory([path.join(base, "a"), path.join(base, "ab")])).toBe(base);
  });
});

describe("writeGraphPage", () => {
  it("writes the page beside the files, naming each by its file name", async () => {
    const root = await makeTempDir();
    const files = await placeFiles(root, {
      "methods/demo/bundle.mthds": BUNDLE,
      "methods/demo/steps.mthds": 'domain = "demo"\n',
    });

    const outcome = await writeGraphPage(root, files);

    expect(outcome).toEqual({
      path: path.join("methods", "demo", GRAPH_PAGE_FILENAME),
      written: true,
      created: true,
    });
    const page = await fs.readFile(path.join(root, "methods/demo", GRAPH_PAGE_FILENAME), "utf8");
    expect(embeddedSources(page)).toEqual([
      { name: "bundle.mthds", content: BUNDLE },
      { name: "steps.mthds", content: 'domain = "demo"\n' },
    ]);
    expect(page).toContain("<title>demo — method graph</title>");
  });

  it("embeds the text it was handed, which is the text validated", async () => {
    const root = await makeTempDir();
    await placeFiles(root, { "bundle.mthds": "on disk" });

    await writeGraphPage(root, [{ path: "bundle.mthds", content: BUNDLE }]);

    const page = await fs.readFile(path.join(root, GRAPH_PAGE_FILENAME), "utf8");
    expect(embeddedSources(page)).toEqual([{ name: "bundle.mthds", content: BUNDLE }]);
  });

  it("writes into the deepest directory holding files that span several", async () => {
    const root = await makeTempDir();
    const files = await placeFiles(root, {
      "methods/demo/bundle.mthds": BUNDLE,
      "methods/demo/parts/steps.mthds": 'domain = "demo"\n',
    });

    const outcome = await writeGraphPage(root, files);

    expect(outcome.path).toBe(path.join("methods", "demo", GRAPH_PAGE_FILENAME));
    const page = await fs.readFile(path.join(root, outcome.path), "utf8");
    expect(embeddedSources(page)).toEqual([
      { name: "bundle.mthds", content: BUNDLE },
      { name: "parts/steps.mthds", content: 'domain = "demo"\n' },
    ]);
  });

  it("draws a file submitted twice once", async () => {
    const root = await makeTempDir();
    await placeFiles(root, { "bundle.mthds": BUNDLE });

    const outcome = await writeGraphPage(root, [
      { path: "bundle.mthds", content: BUNDLE },
      { path: "./bundle.mthds", content: BUNDLE },
    ]);

    expect(outcome.written).toBe(true);
    const page = await fs.readFile(path.join(root, GRAPH_PAGE_FILENAME), "utf8");
    expect(embeddedSources(page)).toEqual([{ name: "bundle.mthds", content: BUNDLE }]);
  });

  it("rewrites a page it wrote before, and says it was not new", async () => {
    const root = await makeTempDir();
    await placeFiles(root, { "bundle.mthds": BUNDLE });
    await writeGraphPage(root, [{ path: "bundle.mthds", content: BUNDLE }]);

    const edited = 'domain = "demo"\nmain_pipe = "other"\n';
    const outcome = await writeGraphPage(root, [{ path: "bundle.mthds", content: edited }]);

    expect(outcome).toEqual({ path: GRAPH_PAGE_FILENAME, written: true, created: false });
    const page = await fs.readFile(path.join(root, GRAPH_PAGE_FILENAME), "utf8");
    expect(embeddedSources(page)).toEqual([{ name: "bundle.mthds", content: edited }]);
  });

  it("leaves a file it did not write untouched", async () => {
    const root = await makeTempDir();
    await placeFiles(root, { "bundle.mthds": BUNDLE, [GRAPH_PAGE_FILENAME]: "<p>mine</p>" });

    const outcome = await writeGraphPage(root, [{ path: "bundle.mthds", content: BUNDLE }]);

    expect(outcome).toMatchObject({
      path: GRAPH_PAGE_FILENAME,
      written: false,
      error: { class: "input_domain", location: "graph_page", retryable: false },
    });
    expect(outcome.error?.message).toContain("generator mark");
    expect(await fs.readFile(path.join(root, GRAPH_PAGE_FILENAME), "utf8")).toBe("<p>mine</p>");
  });

  it("refuses a symlink at the page's name, and writes nothing through it", async () => {
    const root = await makeTempDir();
    await placeFiles(root, { "bundle.mthds": BUNDLE, "target.html": "target" });
    await fs.symlink(path.join(root, "target.html"), path.join(root, GRAPH_PAGE_FILENAME));

    const outcome = await writeGraphPage(root, [{ path: "bundle.mthds", content: BUNDLE }]);

    expect(outcome.written).toBe(false);
    expect(outcome.error?.message).toContain("symlink");
    expect(await fs.readFile(path.join(root, "target.html"), "utf8")).toBe("target");
  });

  it("refuses a directory at the page's name", async () => {
    const root = await makeTempDir();
    await placeFiles(root, { "bundle.mthds": BUNDLE });
    await fs.mkdir(path.join(root, GRAPH_PAGE_FILENAME));

    const outcome = await writeGraphPage(root, [{ path: "bundle.mthds", content: BUNDLE }]);

    expect(outcome.written).toBe(false);
    expect(outcome.error?.message).toContain("not a regular file");
  });

  it("writes beside the files through a symlinked directory inside the workspace", async () => {
    const root = await makeTempDir();
    await placeFiles(root, { "real/bundle.mthds": BUNDLE });
    await fs.symlink(path.join(root, "real"), path.join(root, "linked"));

    const outcome = await writeGraphPage(root, [{ path: "linked/bundle.mthds", content: BUNDLE }]);

    expect(outcome).toMatchObject({ path: path.join("real", GRAPH_PAGE_FILENAME), written: true });
    await expect(fs.stat(path.join(root, "real", GRAPH_PAGE_FILENAME))).resolves.toBeTruthy();
  });

  it("refuses a directory that resolves outside the workspace", async () => {
    const root = await makeTempDir();
    const outside = await makeTempDir();
    await placeFiles(outside, { "bundle.mthds": BUNDLE });
    await fs.symlink(outside, path.join(root, "escape"));

    const outcome = await writeGraphPage(root, [{ path: "escape/bundle.mthds", content: BUNDLE }]);

    expect(outcome).toMatchObject({
      written: false,
      error: { class: "input_domain", location: "graph_page" },
    });
    await expect(fs.stat(path.join(outside, GRAPH_PAGE_FILENAME))).rejects.toThrow();
  });

  it.skipIf(asRoot)("reports a directory it cannot write to without throwing", async () => {
    const root = await makeTempDir();
    await placeFiles(root, { "locked/bundle.mthds": BUNDLE });
    await fs.chmod(path.join(root, "locked"), 0o555);

    try {
      const outcome = await writeGraphPage(root, [
        { path: "locked/bundle.mthds", content: BUNDLE },
      ]);

      expect(outcome).toMatchObject({
        path: path.join("locked", GRAPH_PAGE_FILENAME),
        written: false,
        error: { class: "runtime", location: "graph_page", retryable: false },
      });
    } finally {
      await fs.chmod(path.join(root, "locked"), 0o755);
    }
  });

  it("reports a working directory that does not exist as the deployment's fault", async () => {
    const root = await makeTempDir();

    const outcome = await writeGraphPage(path.join(root, "gone"), [
      { path: "bundle.mthds", content: BUNDLE },
    ]);

    expect(outcome).toMatchObject({
      written: false,
      error: { class: "config", location: "deployment" },
    });
  });
});

describe("graphPageSection", () => {
  it("says what a new page is, where it is, and that it is generated", () => {
    const section = graphPageSection(
      { path: "m/method-graph.html", written: true, created: true },
      true,
    );

    expect(section).toMatch(
      /^## Method graph\n\nWrote the method's flowchart to `m\/method-graph\.html`/,
    );
    expect(section).toContain("cdn.jsdelivr.net");
    expect(section).toContain("generated file");
  });

  it("only says where a rewritten page is", () => {
    expect(
      graphPageSection({ path: "method-graph.html", written: true, created: false }, true),
    ).toBe(
      "## Method graph\n\nRewrote the method's flowchart at `method-graph.html`: open it in a browser to see the graph.",
    );
  });

  const refused: GraphPageOutcome = {
    path: "method-graph.html",
    written: false,
    error: {
      class: "input_domain",
      location: "graph_page",
      message: "It is\nsomebody else's.",
      hint: "Move it.",
      retryable: false,
    },
  };

  it("says why a page was not written, and that the verdict stands", () => {
    expect(graphPageSection(refused, true)).toBe(
      "## Method graph\n\nThe method's flowchart page was not written to `method-graph.html`; the verdict above stands. It is somebody else's.\n\n*Hint: Move it.*",
    );
  });

  it("claims no verdict where the API produced none", () => {
    const section = graphPageSection(refused, false);

    expect(section).toContain("; the result above is unaffected. It is somebody else's.");
    expect(section).not.toContain("verdict");
  });
});
