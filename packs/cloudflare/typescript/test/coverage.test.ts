// Fact-for-fact coverage: every fact of three hand-written Cloudflare configurations is in
// what the generators write from the fixture models that describe the same sites.
//
// The references below are those configurations with every site-specific value replaced
// by the fixtures' placeholders (names, hostnames, ids, account values): the shape, keys,
// numbers, flags and paths are as the originals wrote them. Each leaf of a reference is one
// fact, and each must be in the generated file at the same path with the same value.
//
// The generated files are also checked against Wrangler's own JSON schema (vendored in
// wrangler-schema/), so a key Wrangler would reject fails here rather than on a deploy.
import { describe, expect, test } from "bun:test";
import { parseGeneratedJsonc } from "../src/index.js";
import { emitFixture } from "./model.js";
import { wranglerSchemaErrors } from "./wrangler-schema.js";

type Plain = string | number | boolean | null | Plain[] | { [k: string]: Plain };

/** A Worker with assets, a D1 database and a KV namespace, configured in wrangler.jsonc. */
export const WORKER_WITH_ASSETS: Plain = {
  name: "quiz",
  main: "src/index.ts",
  compatibility_date: "2024-12-30",
  compatibility_flags: ["nodejs_compat"],
  assets: {
    directory: "./public",
    binding: "ASSETS",
    not_found_handling: "single-page-application",
    run_worker_first: ["/api/*", "/c/*"],
  },
  vars: {
    MAX_QUESTIONS_PER_DAY: "5",
    GLOBAL_MAX_PER_DAY: "200",
    IP_MAX_PER_DAY: "10",
    KILL_SWITCH: "off",
    TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
  },
  kv_namespaces: [{ binding: "RATE_LIMIT", id: "00000000000000000000000000000001" }],
  d1_databases: [{ binding: "DB", database_name: "quiz", database_id: "00000000-0000-4000-8000-000000000001", migrations_dir: "migrations" }],
  routes: [
    { pattern: "quiz.example.com", custom_domain: true },
    { pattern: "www.quiz.example.com", custom_domain: true },
  ],
};
/** Its one fact held only in a comment: SEARCH_URL is a Worker secret. */
export const WORKER_WITH_ASSETS_SECRETS = ["SEARCH_URL"];

/** A Worker in front of its assets, with a cron, D1, R2 and five rate limiters, configured in wrangler.toml. */
export const WORKER_WITH_LIMITERS: Plain = {
  name: "trips",
  main: "src/worker.ts",
  compatibility_date: "2026-07-01",
  compatibility_flags: ["nodejs_compat"],
  routes: [
    { pattern: "trips.example.com", custom_domain: true },
    { pattern: "www.trips.example.com", custom_domain: true },
  ],
  workers_dev: false,
  triggers: { crons: ["0 4 * * *"] },
  assets: { directory: "./dist/client", binding: "ASSETS", not_found_handling: "single-page-application", run_worker_first: true },
  d1_databases: [{ binding: "DB", database_name: "trips", database_id: "00000000-0000-4000-8000-000000000003", migrations_dir: ".metaobjects/migrations" }],
  r2_buckets: [{ binding: "PHOTOS", bucket_name: "trips-photos" }],
  unsafe: {
    bindings: [
      { name: "ENTER_LIMITER", type: "ratelimit", namespace_id: "1001", simple: { limit: 10, period: 60 } },
      { name: "ADMIN_LIMITER", type: "ratelimit", namespace_id: "1002", simple: { limit: 200, period: 60 } },
      { name: "LOGIN_LIMITER", type: "ratelimit", namespace_id: "1003", simple: { limit: 10, period: 60 } },
      { name: "LOGIN_LOCKOUT_LIMITER", type: "ratelimit", namespace_id: "1004", simple: { limit: 4, period: 60 } },
      { name: "RECOVERY_LIMITER", type: "ratelimit", namespace_id: "1005", simple: { limit: 3, period: 60 } },
    ],
  },
  vars: {
    ACCESS_TEAM_DOMAIN: "team.example.com",
    ACCESS_AUD: "0000000000000000000000000000000000000000000000000000000000000000",
    NOTIFY_EMAIL: "host@example.com",
  },
};
/** Its secrets, listed only in its .dev.vars.example (the local-only DEV_OPEN_ADMIN is not one). */
export const WORKER_WITH_LIMITERS_SECRETS = ["SESSION_SECRET", "RESEND_API_KEY", "PASSPHRASE_PEPPER", "RECOVERY_ENC_KEY", "RECOVERY_HMAC_KEY"];
/** Its deploy script: build, then deploy with the narrow token from the deploy vault scope. */
export const WORKER_WITH_LIMITERS_DEPLOY = { build: "pnpm build", vaultProject: "acme-deploy", vaultEnv: "dev", token: "ACME_WORKERS_TOKEN" };

/** A Pages site's deploy: `npm run build`, then a pinned `wrangler pages deploy`. */
export const PAGES_DEPLOY = {
  build: "npm run build",
  wranglerVersion: "4.168.0",
  directory: "dist",
  project: "docs-site",
  branch: "main",
  vaultProject: "acme-deploy",
  vaultEnv: "dev",
  token: "ACME_PAGES_TOKEN",
};

/** Each leaf of `v` as [path, value]; an array of scalars is one leaf. */
function facts(v: Plain, path: string[] = []): [string[], Plain][] {
  if (v === null || typeof v !== "object") return [[path, v]];
  if (Array.isArray(v)) return v.every((x) => x === null || typeof x !== "object") ? [[path, v]] : v.flatMap((x, i) => facts(x, [...path, String(i)]));
  return Object.entries(v).flatMap(([k, x]) => facts(x, [...path, k]));
}

function at(v: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>((o, k) => (o !== null && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), v);
}

const generated = emitFixture;

describe("a Worker with assets, D1 and KV (wrangler.jsonc)", () => {
  test("every fact of the reference is at the top level of the generated file", async () => {
    const config = parseGeneratedJsonc((await generated("cloudflare-worker-environments")).get("wrangler.jsonc")!);
    for (const [path, value] of facts(WORKER_WITH_ASSETS)) {
      const got = at(config, path);
      expect({ fact: path.join("."), value: got }).toEqual({ fact: path.join("."), value });
    }
    expect(at(config, ["secrets", "required"])).toEqual(WORKER_WITH_ASSETS_SECRETS);
  });

  test("the staging environment is a complete env block: every key the top level has, with staging's values", async () => {
    const config = parseGeneratedJsonc((await generated("cloudflare-worker-environments")).get("wrangler.jsonc")!) as Record<string, unknown>;
    const staging = at(config, ["env", "staging"]) as Record<string, unknown>;
    const topKeys = Object.keys(config).filter((k) => k !== "$schema" && k !== "env");
    expect(Object.keys(staging)).toEqual(topKeys);
    expect(staging["name"]).toBe("quiz-staging");
    expect(at(staging, ["d1_databases", "0", "database_name"])).toBe("quiz-staging");
    expect(at(staging, ["kv_namespaces", "0", "id"])).toBe("00000000000000000000000000000002");
    expect(at(staging, ["vars", "KILL_SWITCH"])).toBe("on");
    // Inherited from the abstract base, repeated by the generator.
    expect(at(staging, ["vars", "TURNSTILE_SITE_KEY"])).toBe("1x00000000000000000000AA");
    expect(at(staging, ["assets", "run_worker_first"])).toEqual(["/api/*", "/c/*"]);
    expect(at(staging, ["secrets", "required"])).toEqual(["SEARCH_URL"]);
  });
});

describe("a Worker with a cron, D1, R2 and rate limiters (wrangler.toml)", () => {
  test("every fact of the reference is in the generated file; the unsafe rate limiters are first-class ratelimits", async () => {
    const config = parseGeneratedJsonc((await generated("cloudflare-worker-cron-ratelimits")).get("wrangler.jsonc")!);
    const { unsafe, ...rest } = WORKER_WITH_LIMITERS as Record<string, Plain>;
    for (const [path, value] of facts(rest)) {
      const got = at(config, path);
      expect({ fact: path.join("."), value: got }).toEqual({ fact: path.join("."), value });
    }
    const limiters = (unsafe as { bindings: { name: string; namespace_id: string; simple: Plain }[] }).bindings;
    expect(at(config, ["ratelimits"])).toEqual(limiters.map(({ name, namespace_id, simple }) => ({ name, namespace_id, simple })));
    expect(at(config, ["unsafe"])).toBeUndefined();
    expect(at(config, ["secrets", "required"])).toEqual(WORKER_WITH_LIMITERS_SECRETS);
  });

  test("the deploy builds, then deploys through the narrow-token wrapper", async () => {
    const files = await generated("cloudflare-worker-cron-ratelimits");
    const deploy = files.get("deploy/cloudflare/deploy.sh")!;
    const runner = files.get("deploy/cloudflare/wrangler.sh")!;
    const d = WORKER_WITH_LIMITERS_DEPLOY;
    expect(deploy).toContain(`\n  ${d.build}\n`);
    expect(deploy.indexOf(d.build)).toBeLessThan(deploy.indexOf('wrangler.sh "$ENVIRONMENT" deploy'));
    expect(runner).toContain(`VAULT_PROJECT=${d.vaultProject} VAULT_ENV=${d.vaultEnv} TOKEN=${d.token}`);
    expect(runner).toContain("exec env -u CLOUDFLARE_EMAIL -u CLOUDFLARE_API_KEY -u CLOUDFLARE_API_TOKEN");
    expect(runner).toContain('--only "$TOKEN" CLOUDFLARE_ACCOUNT_ID');
    expect(runner).toContain('export CLOUDFLARE_API_TOKEN="${!1}"');
    expect(runner).toContain(': "${CLOUDFLARE_ACCOUNT_ID:?');
  });
});

describe("a Pages site (its deploy command)", () => {
  test("every fact of the reference deploy is in the generated scripts", async () => {
    const files = await generated("cloudflare-pages-site");
    expect(files.has("wrangler.jsonc")).toBe(false);
    const deploy = files.get("deploy/cloudflare/deploy.sh")!;
    const runner = files.get("deploy/cloudflare/wrangler.sh")!;
    const p = PAGES_DEPLOY;
    expect(deploy).toContain(`\n  ${p.build}\n`);
    expect(deploy).toContain(`wrangler.sh "$ENVIRONMENT" pages deploy ${p.directory} --project-name=${p.project} --branch=${p.branch} --commit-hash="$(git rev-parse HEAD)"`);
    expect(runner).toContain(`WRANGLER_VERSION="\${WRANGLER_VERSION:-${p.wranglerVersion}}"`);
    expect(runner).toContain('exec npx --yes "wrangler@$version" "$@"');
    expect(runner).toContain(`VAULT_PROJECT=${p.vaultProject} VAULT_ENV=${p.vaultEnv} TOKEN=${p.token}`);
    expect(runner).toContain("exec env -u CLOUDFLARE_EMAIL -u CLOUDFLARE_API_KEY -u CLOUDFLARE_API_TOKEN");
  });
});

describe("Wrangler's own schema", () => {
  test.each(["cloudflare-worker-environments", "cloudflare-worker-cron-ratelimits"])("%s: wrangler.jsonc is valid", async (scenario) => {
    const config = parseGeneratedJsonc((await generated(scenario)).get("wrangler.jsonc")!);
    expect(wranglerSchemaErrors(config)).toEqual([]);
  });

  test("the schema is strict enough to catch a key Wrangler does not have", () => {
    expect(wranglerSchemaErrors({ name: "x", compatibility_date: "2026-07-01", no_such_key: true })).not.toEqual([]);
  });
});
