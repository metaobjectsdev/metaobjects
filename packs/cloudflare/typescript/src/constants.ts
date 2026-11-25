// The cloudflare pack's vocabulary names and the Cloudflare spellings it writes, one constant
// each (metamodel/cloudflare.json is the vocabulary's definition).

export const CLOUDFLARE_PROVIDER_ID = "metaobjects-cloudflare";

export const DEPLOYMENT_SUBTYPE_WORKER = "worker";
export const DEPLOYMENT_SUBTYPE_PAGES = "pages";

/** The two environments a Pages project has, each with its own variables: what `pages secret put|list --env` takes. */
export const PAGES_ENV_PRODUCTION = "production";
export const PAGES_ENV_PREVIEW = "preview";
export type PagesEnvironment = typeof PAGES_ENV_PRODUCTION | typeof PAGES_ENV_PREVIEW;

export const WORKER_ATTR_SCRIPT = "script";
export const WORKER_ATTR_MAIN = "main";
export const WORKER_ATTR_COMPATIBILITY_DATE = "compatibilityDate";
export const WORKER_ATTR_COMPATIBILITY_FLAGS = "compatibilityFlags";
export const WORKER_ATTR_WORKERS_DEV = "workersDev";
export const WORKER_ATTR_ASSETS_BINDING = "assetsBinding";
export const WORKER_ATTR_NOT_FOUND = "notFound";
export const WORKER_ATTR_WORKER_FIRST = "workerFirst";
export const WORKER_ATTR_WORKER_FIRST_PATHS = "workerFirstPaths";
export const WORKER_ATTR_JOBS = "jobs";
export const WORKER_ATTR_EXTRA = "extra";
export const PAGES_ATTR_PROJECT = "project";
export const ATTR_TOKEN_SECRET = "tokenSecret";
export const ATTR_TOKEN_VAULT = "tokenVault";

/** The binding children of a deployment.worker. */
export const TYPE_CLOUDFLARE = "cloudflare";
export const BINDING_D1 = "d1";
export const BINDING_KV = "kv";
export const BINDING_R2 = "r2";
export const BINDING_QUEUE = "queue";
export const BINDING_RATELIMIT = "ratelimit";
export const D1_ATTR_DATABASE_NAME = "databaseName";
export const D1_ATTR_DATABASE_ID = "databaseId";
export const D1_ATTR_MIGRATIONS_DIR = "migrationsDir";
export const KV_ATTR_NAMESPACE_ID = "namespaceId";
export const R2_ATTR_BUCKET_NAME = "bucketName";
export const QUEUE_ATTR_QUEUE = "queue";
export const RATELIMIT_ATTR_NAMESPACE_ID = "namespaceId";
export const RATELIMIT_ATTR_LIMIT = "limit";
export const RATELIMIT_ATTR_PERIOD = "period";
/** The periods the Workers rate limiting binding accepts, in seconds. */
export const RATELIMIT_PERIODS: readonly number[] = [10, 60];

/** The vault entry, beside the deploy token, that holds the Cloudflare account id. */
export const ACCOUNT_ID_SECRET = "CLOUDFLARE_ACCOUNT_ID";
/** What Wrangler reads the token from; the scripts set it from the deployment's @tokenSecret. */
export const API_TOKEN_VARIABLE = "CLOUDFLARE_API_TOKEN";
/** The global-key variables Wrangler would prefer over a token: the scripts unset them. */
export const GLOBAL_KEY_VARIABLES: readonly string[] = ["CLOUDFLARE_EMAIL", "CLOUDFLARE_API_KEY"];

/** What the runner clears before it sets the vault's token: the global key, and any token the shell already holds. */
export const CLEARED_VARIABLES: readonly string[] = [...GLOBAL_KEY_VARIABLES, API_TOKEN_VARIABLE];

/** The `wrangler` npm package version the generated file and scripts were written against, and that the scripts pin. */
export const WRANGLER_VERSION = "4.168.0";
/** Where the generated file points editors for Wrangler's JSON schema (a project with wrangler installed). */
export const WRANGLER_SCHEMA_REF = "node_modules/wrangler/config-schema.json";

/** Default output paths, relative to the generator's target (the repository root). */
export const PATH_WRANGLER = "wrangler.jsonc";
export const PATH_WRANGLER_RUNNER = "deploy/cloudflare/wrangler.sh";
export const PATH_DEPLOY = "deploy/cloudflare/deploy.sh";
export const PATH_SYNC_SECRETS = "deploy/cloudflare/sync-secrets.sh";
export const PATH_DOCTOR = "deploy/cloudflare/doctor.sh";
export const PATH_UNEXPRESSED = "deploy/cloudflare/unexpressed.md";
