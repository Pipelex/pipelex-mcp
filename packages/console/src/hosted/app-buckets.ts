/**
 * The hosted platform's per-environment app buckets, where run outputs and
 * uploaded inputs are stored, as the CSP sources the console's views are
 * allowed to reach. Every source is one bucket's own host, a plain origin,
 * because that is the only form each host's CSP reliably carries:
 *
 * - the platform (`pipelex-server`) signs on the GLOBAL virtual-hosted form,
 *   `<bucket>.s3.amazonaws.com`, with boto3's default endpoint: its upload
 *   grants (measured against api-dev on 2026-09-23) and the fresh links its
 *   bulk resolve route mints (measured on 2026-09-25), which is where both
 *   views load a run's images and frame its documents from, since the console
 *   puts a fresh link for each stored file on the results' `_meta`;
 * - the regional virtual-hosted form, `<bucket>.s3.us-west-2.amazonaws.com`,
 *   is what the same signing produces once an endpoint is pinned, so pinning it
 *   later does not blank every picture or break every upload.
 *
 * What is deliberately NOT here is the runtime's own link. `pipelex`'s S3
 * provider signs a run's baked `public_url` PATH-style on the shared regional
 * endpoint (`s3.us-west-2.amazonaws.com/<bucket>/<key>`), a host every bucket
 * in the region shares. A bucket there can be scoped only by path, and no host
 * kept the path: the console shipped such entries (`2617d86`), and the Dev
 * console's acceptance on 2026-09-25 showed a run's outputs with no images. An
 * origin alone would let a view load from, and leak data in a URL to, any
 * bucket anyone owns there, so the views paint from the platform's fresh links
 * instead and a baked link that the kernel falls back to stays blocked.
 *
 * Kept free of Skybridge so the live suite can import it.
 */

const APP_BUCKETS = ["pipelex-app-dev", "pipelex-app-staging", "pipelex-app-prod"] as const;

/** The global virtual-hosted form: `https://<bucket>.s3.amazonaws.com`, what the platform signs. */
const APP_BUCKET_GLOBAL_ORIGINS = APP_BUCKETS.map((bucket) => `https://${bucket}.s3.amazonaws.com`);

/** The regional virtual-hosted form: `https://<bucket>.s3.us-west-2.amazonaws.com`. */
const APP_BUCKET_REGIONAL_ORIGINS = APP_BUCKETS.map(
  (bucket) => `https://${bucket}.s3.us-west-2.amazonaws.com`,
);

/**
 * Where both views load a run's images and frame its documents from: each
 * bucket's own host, in both virtual-hosted forms. Do not merge this with a
 * list that drops a form, and never add the shared regional endpoint.
 */
export const RUN_OUTPUT_SOURCES = [...APP_BUCKET_GLOBAL_ORIGINS, ...APP_BUCKET_REGIONAL_ORIGINS];

/**
 * What the `run-graph` view may connect to, to send a picked file with a grant:
 * the grant's host, in either virtual-hosted form. `upload-grant.e2e.ts` checks
 * a live grant's host against it.
 */
export const UPLOAD_CONNECT_DOMAINS = [
  ...APP_BUCKET_GLOBAL_ORIGINS,
  ...APP_BUCKET_REGIONAL_ORIGINS,
];
