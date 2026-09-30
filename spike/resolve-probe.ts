import { createPipelexApiClient } from "../packages/core/src/capabilities/shared.js";
const client = createPipelexApiClient({
  baseUrl: process.env.PIPELEX_E2E_BASE_URL || "https://api-dev.pipelex.com",
  apiKey: process.env.PIPELEX_E2E_API_KEY,
});
const r = (await client.resolve({ method_ref: process.argv[2] } as never)) as { is_valid: boolean; crate?: Record<string, unknown> };
console.log("is_valid", r.is_valid);
const crate = r.crate ?? {};
for (const [k, v] of Object.entries(crate)) {
  const s = JSON.stringify(v);
  console.log(k, typeof v, Array.isArray(v) ? `array(${(v as unknown[]).length})` : "", s.slice(0, 300));
}
