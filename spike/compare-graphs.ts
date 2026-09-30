// Spike: the static graph (built locally from the .mthds text by mthds-ui)
// beside the dry-run graph (returned by POST /v1/validate), for a list of
// bundle directories. Throwaway — run with:
//   set -a; source .env; set +a; npx tsx spike/compare-graphs.ts <dir>...
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import {
  buildStaticGraphSpecFromToml,
  orderMthdsSources,
} from "@pipelex/mthds-ui/static-graph";

import { createPipelexApiClient } from "../packages/core/src/capabilities/shared.js";

type Spec = {
  pipeline_ref?: unknown;
  meta?: { mode?: string };
  nodes: { id: string; kind: string; pipe_code?: string; pipe_type?: string; domain_code?: string }[];
  edges: { kind: string }[];
  pipe_registry?: Record<string, unknown>;
  concept_registry?: Record<string, unknown>;
};

function sourcesOf(target: string): { name: string; content: string }[] {
  if (statSync(target).isFile()) {
    return [{ name: path.basename(target), content: readFileSync(target, "utf8") }];
  }
  return readdirSync(target)
    .filter((f) => f.endsWith(".mthds"))
    .sort()
    .map((f) => ({ name: f, content: readFileSync(path.join(target, f), "utf8") }));
}

function tally(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .sort()
    .map(([k, n]) => `${k}×${n}`)
    .join(" ");
}

function pipeCalls(spec: Spec): string[] {
  return spec.nodes
    .filter((n) => n.pipe_code !== undefined)
    .map((n) => `${n.domain_code ?? "?"}.${n.pipe_code}`)
    .sort();
}

function describe(label: string, spec: Spec | undefined, ms: number): void {
  if (spec === undefined) {
    console.log(`  ${label}: none (${ms} ms)`);
    return;
  }
  console.log(
    `  ${label} (${ms} ms): mode=${spec.meta?.mode ?? "∅"} nodes=${spec.nodes.length} edges=${spec.edges.length}` +
      ` pipes=${Object.keys(spec.pipe_registry ?? {}).length} concepts=${Object.keys(spec.concept_registry ?? {}).length}`,
  );
  console.log(`    pipeline_ref=${JSON.stringify(spec.pipeline_ref)}`);
  console.log(`    node kinds: ${tally(spec.nodes.map((n) => n.kind))}`);
  console.log(`    edge kinds: ${tally(spec.edges.map((e) => e.kind))}`);
}

const client = createPipelexApiClient({
  baseUrl: process.env.PIPELEX_E2E_BASE_URL || "https://api-dev.pipelex.com",
  apiKey: process.env.PIPELEX_E2E_API_KEY,
});

for (const target of process.argv.slice(2)) {
  const sources = sourcesOf(target);
  console.log(`\n## ${target} (${sources.length} file(s))`);

  let t0 = Date.now();
  const ordered = orderMthdsSources(sources);
  const { spec: staticSpec, diagnostics } = buildStaticGraphSpecFromToml(
    ordered.map((s) => s.content),
  );
  const staticMs = Date.now() - t0;

  t0 = Date.now();
  let drySpec: Spec | undefined;
  let verdict = "";
  try {
    const report = (await client.validate(
      sources.map((s) => s.content),
      true,
      undefined,
      undefined,
      ["input_form", "output_form"],
    )) as { is_valid: boolean; is_runnable?: boolean; graph_spec?: Spec };
    verdict = `is_valid=${report.is_valid} is_runnable=${report.is_runnable}`;
    drySpec = report.graph_spec;
  } catch (err) {
    verdict = `threw: ${(err as Error).message.slice(0, 200)}`;
  }
  const dryMs = Date.now() - t0;

  console.log(`  validate: ${verdict}`);
  describe("static", staticSpec as unknown as Spec, staticMs);
  if (diagnostics.length > 0) {
    console.log(`    diagnostics: ${diagnostics.map((d) => `${d.severity}:${d.code}`).join(", ")}`);
  }
  describe("dry", drySpec, dryMs);

  if (drySpec !== undefined) {
    const s = pipeCalls(staticSpec as unknown as Spec);
    const d = pipeCalls(drySpec);
    const onlyStatic = s.filter((x) => !d.includes(x));
    const onlyDry = d.filter((x) => !s.includes(x));
    console.log(
      `    pipe calls: static ${s.length}, dry ${d.length}; only static: [${[...new Set(onlyStatic)].join(", ")}]; only dry: [${[...new Set(onlyDry)].join(", ")}]`,
    );
    const sk = Object.keys((staticSpec as unknown as Spec).pipe_registry ?? {}).sort();
    const dk = Object.keys(drySpec.pipe_registry ?? {}).sort();
    if (JSON.stringify(sk) !== JSON.stringify(dk)) {
      console.log(`    pipe_registry keys differ: static [${sk.join(", ")}] vs dry [${dk.join(", ")}]`);
    }
  }
}
