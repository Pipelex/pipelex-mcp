/**
 * The hosted platform's per-environment app buckets, where run outputs and
 * uploaded inputs are stored, as the origins the console's views are allowed
 * to reach. Two views reach them, through two different host names, because
 * two different services mint the links:
 *
 * - the runtime (`pipelex`'s S3 storage provider) signs run outputs against the
 *   REGIONAL endpoint, so `run-follow` loads images from
 *   `<bucket>.s3.us-west-2.amazonaws.com`;
 * - the platform (`pipelex-server`'s `AppStorageS3Adapter`) signs upload grants
 *   with boto3's default endpoint, which is the GLOBAL
 *   `<bucket>.s3.amazonaws.com` — measured against api-dev on 2026-09-23.
 *
 * So `run-graph`, which sends a picked file with a grant, is allowed both forms:
 * the platform pinning its endpoint later must not silently break uploads, and
 * both names reach the same three buckets. Do not merge the two into one list
 * that drops either form. `upload-grant.e2e.ts` checks a live grant's host
 * against {@link UPLOAD_CONNECT_DOMAINS}.
 *
 * Kept free of Skybridge so the live suite can import it.
 */

const APP_BUCKETS = ["pipelex-app-dev", "pipelex-app-staging", "pipelex-app-prod"] as const;

/** Where the runtime's presigned read links point: the `run-follow` view's image sources. */
export const APP_BUCKET_REGIONAL_ORIGINS = APP_BUCKETS.map(
  (bucket) => `https://${bucket}.s3.us-west-2.amazonaws.com`,
);

/** Where the platform's upload grants point today. */
const APP_BUCKET_GLOBAL_ORIGINS = APP_BUCKETS.map((bucket) => `https://${bucket}.s3.amazonaws.com`);

/** What the `run-graph` view may connect to: an upload grant's host, in either form. */
export const UPLOAD_CONNECT_DOMAINS = [
  ...APP_BUCKET_GLOBAL_ORIGINS,
  ...APP_BUCKET_REGIONAL_ORIGINS,
];
