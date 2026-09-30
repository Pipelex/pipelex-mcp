// Spike: write two standalone pages for one bundle, the static graph (from the
// sources) and the dry-run graph (from /v1/validate), with the console view's
// settings (LR, controllers shown). Run with:
//   set -a; source .env; set +a; npx tsx spike/render-pages.ts <bundle-dir> <out-dir>
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { MTHDS_SOURCES_EMBED_ID } from "@pipelex/mthds-ui/static-graph";

import { renderGraphPage } from "../packages/core/src/capabilities/graph-page.js";
import { createPipelexApiClient } from "../packages/core/src/capabilities/shared.js";

const [dir, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const sources = readdirSync(dir)
  .filter((f) => f.endsWith(".mthds"))
  .sort()
  .map((f) => ({ name: f, content: readFileSync(path.join(dir, f), "utf8") }));

const config = JSON.stringify({ direction: "LR", showControllers: true, theme: "light" });
const withConfig = (page: string) =>
  page.replace(/(<script type="application\/json" id="pipelex-config">)[^<]*(<\/script>)/, `$1${config}$2`);

const staticPage = withConfig(renderGraphPage(`${path.basename(dir)} — static`, sources));
writeFileSync(path.join(out, "static.html"), staticPage);

const client = createPipelexApiClient({
  baseUrl: process.env.PIPELEX_E2E_BASE_URL || "https://api-dev.pipelex.com",
  apiKey: process.env.PIPELEX_E2E_API_KEY,
});
const report = (await client.validate(sources.map((s) => s.content), true, undefined, undefined, [
  "input_form",
  "output_form",
])) as { graph_spec?: unknown };
const dryJson = JSON.stringify(report.graph_spec).replace(/</g, "\\u003c");
const dryPage = staticPage
  .replace(`${path.basename(dir)} — static`, `${path.basename(dir)} — dry run`)
  .replace(
    new RegExp(`<script type="application/json" id="${MTHDS_SOURCES_EMBED_ID}">[\\s\\S]*?</script>`),
    `<script type="application/json" id="pipelex-graphspec">${dryJson}</script>`,
  );
writeFileSync(path.join(out, "dry.html"), dryPage);
console.log(`wrote ${out}/static.html and ${out}/dry.html`);
