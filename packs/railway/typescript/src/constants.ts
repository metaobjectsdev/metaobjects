// The railway pack's vocabulary names and the Railway spellings it writes, one constant each
// (metamodel/railway.json is the vocabulary's definition).

export const RAILWAY_PROVIDER_ID = "metaobjects-railway";
export const DEPLOYMENT_SUBTYPE_RAILWAY = "railway";
export const RAILWAY_ATTR_PROJECT = "project";
export const RAILWAY_ATTR_SERVICE = "service";
export const RAILWAY_ATTR_REPO = "repo";
export const RAILWAY_ATTR_IMAGE = "image";
export const RAILWAY_ATTR_CHECK_SUITES = "checkSuites";

/** The `railway` npm package version the generated file and scripts were written against. */
export const RAILWAY_SDK_VERSION = "3.17.0";

/** The module the generated file imports the DSL from. */
export const RAILWAY_IAC_MODULE = "railway/iac";

/** A Railway named partial: 1 to 64 of `a-z A-Z 0-9 . _ -` (Railway's IaC page). */
export const PARTIAL_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** `runtime.process @restart` → Railway's `deploy.restartPolicyType`. */
export const RESTART_POLICY: Readonly<Record<string, string>> = {
  always: "ALWAYS",
  onFailure: "ON_FAILURE",
  never: "NEVER",
};

/**
 * The variable a Railway database template provides for each `value.ref @output`, by
 * `resource.* @engine`. Railway names them on its database templates (and the `railway`
 * SDK's `PostgresVariable` / `RedisVariable` / `MySqlVariable` / `MongoVariable` types).
 */
export const DATABASE_OUTPUTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  postgres: { url: "DATABASE_URL", publicUrl: "DATABASE_PUBLIC_URL", host: "PGHOST", port: "PGPORT", user: "PGUSER", password: "PGPASSWORD" },
  mysql: { url: "MYSQL_URL", publicUrl: "MYSQL_PUBLIC_URL", host: "MYSQLHOST", port: "MYSQLPORT", user: "MYSQLUSER", password: "MYSQLPASSWORD" },
  redis: { url: "REDIS_URL", publicUrl: "REDIS_PUBLIC_URL", host: "REDISHOST", port: "REDISPORT", user: "REDISUSER", password: "REDISPASSWORD" },
  mongo: { url: "MONGO_URL", publicUrl: "MONGO_PUBLIC_URL", host: "MONGOHOST", port: "MONGOPORT", user: "MONGOUSER", password: "MONGOPASSWORD" },
};

/** Railway's variables for another service's addresses. */
export const RAILWAY_PRIVATE_DOMAIN = "RAILWAY_PRIVATE_DOMAIN";
export const RAILWAY_PUBLIC_DOMAIN = "RAILWAY_PUBLIC_DOMAIN";

/** Default output paths, relative to the generator's target (the repository root). */
export const PATH_RAILWAY_TS = ".railway/railway.ts";
export const PATH_UNEXPRESSED = "deploy/unexpressed.md";
export const PATH_SYNC_SECRETS = "deploy/sync-secrets.sh";
export const PATH_DEPLOY = "deploy/deploy.sh";
export const PATH_DOCTOR = "deploy/doctor.sh";
export const PATH_DEPLOY_SKILL = ".claude/skills/deploy/SKILL.md";
