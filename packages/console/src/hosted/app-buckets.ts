/**
 * The hosted platform's per-environment app buckets, where run outputs and
 * uploaded inputs are stored, as the CSP sources the console's views are
 * allowed to reach. Two views reach them, in three URL forms, because two
 * different services mint the links and neither uses S3's recommended form
 * for both:
 *
 * - the runtime (`pipelex`'s S3 storage provider) signs run outputs PATH-style
 *   on the REGIONAL endpoint, `https://s3.us-west-2.amazonaws.com/<bucket>/<key>`,
 *   because it hands boto an explicit `endpoint_url` and no addressing style —
 *   measured on a completed run's results against api-dev on 2026-09-25. So
 *   both views load a run's images, and frame its documents, from that form;
 * - the platform (`pipelex-server`'s `AppStorageS3Adapter`) signs upload grants
 *   with boto3's default endpoint, which is the GLOBAL virtual-hosted
 *   `<bucket>.s3.amazonaws.com` — measured against api-dev on 2026-09-23.
 *
 * A path-style link shares its host with every bucket in the region, so the
 * run-output sources carry the bucket as a path (`…amazonaws.com/<bucket>/`),
 * which CSP matches as a prefix: an origin alone would let a view load from,
 * and leak data in a URL to, any bucket anyone owns there. Beside them sit the
 * regional virtual-hosted origins, the form a runtime that named an addressing
 * style would produce, so such a change does not blank every picture.
 *
 * `run-graph`, which also sends a picked file with a grant, may connect to both
 * virtual-hosted forms: the platform pinning its endpoint later must not
 * silently break uploads, and both names reach the same three buckets. Do not
 * merge these lists into one that drops a form. `upload-grant.e2e.ts` checks a
 * live grant's host against {@link UPLOAD_CONNECT_DOMAINS}.
 *
 * Kept free of Skybridge so the live suite can import it.
 */

const APP_BUCKETS = ["pipelex-app-dev", "pipelex-app-staging", "pipelex-app-prod"] as const;

const S3_REGIONAL_ENDPOINT = "https://s3.us-west-2.amazonaws.com";

/** The regional virtual-hosted form: `https://<bucket>.s3.us-west-2.amazonaws.com`. */
const APP_BUCKET_REGIONAL_ORIGINS = APP_BUCKETS.map(
  (bucket) => `https://${bucket}.s3.us-west-2.amazonaws.com`,
);

/**
 * Where a run's output files are served from, and so where both views load a
 * run's images and frame its documents from: the path-style form the runtime
 * signs today, scoped to each bucket, then the regional virtual-hosted form.
 */
export const RUN_OUTPUT_SOURCES = [
  ...APP_BUCKETS.map((bucket) => `${S3_REGIONAL_ENDPOINT}/${bucket}/`),
  ...APP_BUCKET_REGIONAL_ORIGINS,
];

/** Where the platform's upload grants point today. */
const APP_BUCKET_GLOBAL_ORIGINS = APP_BUCKETS.map((bucket) => `https://${bucket}.s3.amazonaws.com`);

/** What the `run-graph` view may connect to: an upload grant's host, in either form. */
export const UPLOAD_CONNECT_DOMAINS = [
  ...APP_BUCKET_GLOBAL_ORIGINS,
  ...APP_BUCKET_REGIONAL_ORIGINS,
];
