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
 * - the runtime (`pipelex` from 0.66.0) signs a run's baked `public_url` on
 *   the REGIONAL virtual-hosted form, `<bucket>.s3.us-west-2.amazonaws.com`
 *   (measured against api-dev on 2026-09-26), which is also what the platform's
 *   signing produces once an endpoint is pinned. So a baked link the kernel
 *   falls back to paints until it expires, an hour after the run for an output,
 *   and so does a link a method writes into an HTML output's markup, which no
 *   fresh link can replace.
 *
 * What is deliberately NOT here is the shared regional endpoint,
 * `s3.us-west-2.amazonaws.com`, where the runtime signed PATH-style before
 * 0.66.0 (`s3.us-west-2.amazonaws.com/<bucket>/<key>`) and still does for a
 * bucket name that cannot be a hostname, which none of these is. A bucket there
 * can be scoped only by path, and no host kept the path: the console shipped
 * such entries (`2617d86`), and the Dev console's acceptance on 2026-09-25
 * showed a run's outputs with no images. An origin alone would let a view load
 * from, and leak data in a URL to, any bucket anyone owns there.
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
