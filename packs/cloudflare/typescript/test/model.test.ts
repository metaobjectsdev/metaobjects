// What the model reader does with each fixture, and what it refuses: every refusal names the
// node, and every problem in a model is reported at once.
import { describe, expect, test } from "bun:test";
import { CloudflareModelError, parseGeneratedJsonc, readCloudflare, type PagesDeployment, type WorkerDeployment } from "../src/index.js";
import { editFixture, emit, loadModels, type Source } from "./model.js";
import { wranglerSchemaErrors } from "./wrangler-schema.js";

type Node = Record<string, Record<string, unknown>>;
type Root = { "metadata.root": { children: Node[] } };

/** The body of the root child `type` named `name`. */
function child(root: Root, type: string, name: string): Record<string, unknown> {
  const hit = root["metadata.root"].children.find((c) => c[type]?.["name"] === name);
  if (hit === undefined) throw new Error(`no ${type} ${name}`);
  return hit[type]!;
}

function children(node: Record<string, unknown>): Node[] {
  return (node["children"] ??= []) as Node[];
}

/** The problems reading `sources` reports, or [] when it reads clean. */
async function problems(sources: readonly Source[], opts: Parameters<typeof readCloudflare>[3] = {}): Promise<readonly string[]> {
  const root = await loadModels(sources);
  try {
    readCloudflare(root, root.children().filter((c) => c.type === "object") as never, () => true, opts);
    return [];
  } catch (e) {
    if (e instanceof CloudflareModelError) return e.problems;
    throw e;
  }
}

async function read(sources: readonly Source[], opts: Parameters<typeof readCloudflare>[3] = {}) {
  const root = await loadModels(sources);
  return readCloudflare(root, root.children().filter((c) => c.type === "object") as never, () => true, opts)!;
}

const ENVS = "cloudflare-worker-environments";
const TRIPS = "cloudflare-worker-cron-ratelimits";
const PAGES = "cloudflare-pages-site";
const PAGES_SECRETS = "cloudflare-pages-secrets";

describe("reading", () => {
  test("an abstract deployment is a base, never deployed; each environment resolves what it inherits", async () => {
    const app = await read(editFixture(ENVS, () => {}));
    expect(app.deployments.map((d) => d.key)).toEqual(["acme::quiz::siteProduction", "acme::quiz::siteStaging"]);
    const staging = app.deployments[1] as WorkerDeployment;
    expect(staging.main).toBe("src/index.ts");
    expect(staging.bindings.map((b) => b.from)).toEqual(["cloudflare.d1 db", "cloudflare.kv rateLimit"]);
    expect((app.deployments[0] as WorkerDeployment).bindings.map((b) => b.from)).toEqual(["cloudflare.d1 db (from siteBase)", "cloudflare.kv rateLimit (from siteBase)"]);
  });

  test("a resource managed outside Cloudflare is not bound, and is listed with how it is reached", async () => {
    const sources = editFixture(TRIPS, (r) => {
      const sys = child(r, "system.internal", "Trips");
      for (const c of children(sys)) if (c["resource.bucket"] !== undefined) c["resource.bucket"]["@managedBy"] = "external";
      const d = child(r, "deployment.worker", "webProduction");
      d["children"] = children(d).filter((c) => c["cloudflare.r2"] === undefined);
    });
    const app = await read(sources);
    const d = app.deployments[0] as WorkerDeployment;
    expect(d.bindings.some((b) => b.kind === "r2")).toBe(false);
    expect(d.unexpressed.map((f) => f.fact)).toContain("resource.bucket `photos`, managed outside Cloudflare");
  });

  test("@extra keys reach the environment's block as written, and the result is still valid Wrangler", async () => {
    const sources = editFixture(TRIPS, (r) => {
      child(r, "deployment.worker", "webProduction")["@extra"] = JSON.stringify({ placement: { mode: "smart" }, observability: { enabled: true } });
    });
    const config = parseGeneratedJsonc((await emit(await loadModels(sources))).get("wrangler.jsonc")!) as Record<string, unknown>;
    expect(config["placement"]).toEqual({ mode: "smart" });
    expect(config["observability"]).toEqual({ enabled: true });
    expect(wranglerSchemaErrors(config)).toEqual([]);
    expect(wranglerSchemaErrors({ ...config, placement: { mode: "bogus" } })).toContain("/placement/mode must be equal to one of the allowed values");
  });

  test("a value.ref takes another Cloudflare-deployed app's publicUrl with its @path", async () => {
    const sources = editFixture(TRIPS, (r) => {
      children(child(r, "system.internal", "Trips")).push({ "app.service": { name: "api" } });
      children(child(r, "object.settings", "Notify")).push({ "field.string": { "name": "apiBase", "@envName": "NOTIFY_API_BASE" } });
      r["metadata.root"].children.push({
        "deployment.worker": { name: "apiProduction", "@app": "Trips.api", "@environment": "production", "@compatibilityDate": "2026-07-01", "@tokenSecret": "T", "@domains": ["api.example.com"] },
      });
      children(child(r, "deployment.worker", "webProduction")).push({ "value.ref": { name: "apiBase", "@setting": "Notify.apiBase", "@producedBy": "Trips.api", "@output": "publicUrl", "@path": "/v1" } });
    });
    const web = (await read(sources, { app: "Trips.web" })).deployments[0] as WorkerDeployment;
    expect(web.vars.find((v) => v.name === "NOTIFY_API_BASE")).toEqual({ name: "NOTIFY_API_BASE", value: "https://api.example.com/v1", from: "value.ref apiBase" });
  });

  test("a value.ref an app cannot supply is refused with what to ask it for instead", async () => {
    const sources = editFixture(TRIPS, (r) => {
      children(child(r, "system.internal", "Trips")).push({
        "app.service": { name: "api", "children": [{ "runtime.process": { name: "web", "@port": 8080 } }] },
      });
      children(child(r, "object.settings", "Notify")).push({ "field.string": { "name": "apiBase", "@envName": "NOTIFY_API_BASE" } });
      children(child(r, "deployment.worker", "webProduction")).push({ "value.ref": { name: "apiBase", "@setting": "Notify.apiBase", "@producedBy": "Trips.api", "@output": "port" } });
    });
    expect(await problems(sources)).toEqual([
      "deployment.worker acme::trips::webProduction value.ref apiBase: Cloudflare resolves no reference at deploy time; a value.ref can only take another Cloudflare-deployed app's host or publicUrl (from its @domains), not an app's port. Ask for its host or publicUrl, or give the setting a value.literal",
    ]);
  });

  test("a Worker's @branch is held by no file and is listed; a Pages site's is carried by its upload", async () => {
    const worker = await read(editFixture(ENVS, () => {}));
    expect(worker.deployments.map((d) => d.unexpressed.find((f) => f.fact.startsWith("@branch")))).toEqual([
      { fact: "@branch `main`", how: "Deploys run from deploy/cloudflare/deploy.sh, not on a push to the branch, so no file holds it." },
      { fact: "@branch `staging`", how: "Deploys run from deploy/cloudflare/deploy.sh, not on a push to the branch, so no file holds it." },
    ]);
    const pages = await read(editFixture(PAGES, () => {}));
    expect(pages.deployments.every((d) => d.unexpressed.every((f) => !f.fact.startsWith("@branch")))).toBe(true);
  });

  test("a build-time value.literal a Pages site's deploy script exports is not listed as unexpressed", async () => {
    const sources = editFixture(PAGES, (r) => {
      children(child(r, "deployment.pages", "siteProduction")).push({ "value.literal": { name: "url", "@setting": "Site.url", "@literal": "https://production.docs.example.com" } });
    });
    const production = (await read(sources)).deployments[0] as PagesDeployment;
    expect(production.buildVars).toEqual([{ name: "SITE_URL", value: "https://production.docs.example.com", from: "value.literal url" }]);
    expect(production.unexpressed.map((f) => f.fact)).toEqual(["Build-time settings `SITE_URL`", "Custom domains `docs.example.com`"]);
  });

  test("the build-time settings row says whether the deploy script runs a build", async () => {
    const fact = "Build-time settings `SITE_URL`";
    const withCommand = (await read(editFixture(PAGES, () => {}))).deployments[0]!;
    expect(withCommand.unexpressed.find((f) => f.fact === fact)?.how).toBe(
      "Read by the build, which runs on the deploying machine: deploy/cloudflare/deploy.sh exports each one the model gives a value (a value already in the environment wins) and runs the build there. They never reach Cloudflare as settings.",
    );
    const committed = editFixture(PAGES, (r) => {
      const [site] = children(child(r, "system.internal", "Docs")) as { "app.client"?: { children?: { "build.static"?: Record<string, unknown> }[] } }[];
      const [pages] = site!["app.client"]!.children!;
      delete pages!["build.static"]!["@command"];
    });
    expect((await read(committed)).deployments[0]!.unexpressed.find((f) => f.fact === fact)?.how).toBe(
      "Read by whatever builds site, from the environment it runs in: deploy/cloudflare/deploy.sh runs no build (site declares no build command) and exports each one the model gives a value (a value already in the environment wins) for what it runs next. They never reach Cloudflare as settings.",
    );
    const deploy = (await emit(await loadModels(committed))).get("deploy/cloudflare/deploy.sh")!;
    expect(deploy.split("\n").filter((l) => l.includes("build"))).toEqual([
      "#   2. uploads the build to the environment's Pages project and branch, recording the commit.",
      "# Build-time settings are read from this machine's environment by whatever builds site; deploy.sh runs no",
      "# build (the app declares no build command), and exports the values the model gives first; a value already",
    ]);
  });

  test("a model that deploys nothing to Cloudflare gets no files", async () => {
    const sources = editFixture(TRIPS, (r) => {
      r["metadata.root"].children = r["metadata.root"].children.filter((c) => c["deployment.worker"] === undefined);
    });
    expect((await emit(await loadModels(sources))).size).toBe(0);
  });
});

describe("refusals", () => {
  test("a binding for a resource the app does not need", async () => {
    const sources = editFixture(TRIPS, (r) => {
      children(child(r, "deployment.worker", "webProduction")).push({ "cloudflare.kv": { name: "sessions", "@namespaceId": "x" } });
    });
    expect(await problems(sources)).toEqual([
      'deployment.worker acme::trips::webProduction cloudflare.kv sessions: web needs no resource.keyvalue named "sessions" (@needs); a binding is named after the resource it places',
    ]);
  });

  test("a resource the app needs with no binding in some environment", async () => {
    const sources = editFixture(TRIPS, (r) => {
      const d = child(r, "deployment.worker", "webProduction");
      d["children"] = children(d).filter((c) => c["cloudflare.r2"] === undefined);
    });
    expect(await problems(sources)).toEqual([
      'deployment.worker acme::trips::webProduction: web needs resource.bucket "photos" and environment production has no cloudflare.r2 "photos" binding it; the Worker would fail when it reaches for it',
    ]);
  });

  test("a required setting with no value, a value for a secret, a period Cloudflare refuses, both worker-first forms: all at once", async () => {
    const sources = editFixture(TRIPS, (r) => {
      const d = child(r, "deployment.worker", "webProduction");
      d["@workerFirstPaths"] = ["/api/*"];
      d["children"] = children(d).filter((c) => c["value.literal"]?.["name"] !== "teamDomain");
      children(d).push({ "value.literal": { name: "session", "@setting": "Auth.sessionSecret", "@literal": "x" } });
      for (const c of children(d)) if (c["cloudflare.ratelimit"]?.["name"] === "loginLockoutLimiter") c["cloudflare.ratelimit"]["@period"] = 900;
    });
    const got = await problems(sources);
    expect(got).toContain("deployment.worker acme::trips::webProduction value.literal session: Auth.sessionSecret is @secret; its value comes from the vault, never from a value node");
    expect(got).toContain(
      "deployment.worker acme::trips::webProduction: acme::trips::Access.teamDomain (ACCESS_TEAM_DOMAIN) is required and has no value here: give it a value.literal on the deployment, a @default, or mark it @secret",
    );
    expect(got).toContain("deployment.worker acme::trips::webProduction cloudflare.ratelimit loginLockoutLimiter: @period 900: the rate limiting binding accepts 10 or 60 seconds only");
    expect(got).toContain("deployment.worker acme::trips::webProduction: @workerFirst and @workerFirstPaths both set; say every request, or which paths");
    expect(got).toHaveLength(4);
  });

  test("@main set in one environment and not another: Wrangler would inherit it", async () => {
    const sources = editFixture(ENVS, (r) => {
      const base = child(r, "deployment.worker", "siteBase");
      child(r, "deployment.worker", "siteProduction")["@main"] = base["@main"];
      delete base["@main"];
    });
    expect(await problems(sources)).toEqual([
      "app.service acme::quiz::Quiz.site: @main is set in production and not in staging; Wrangler would fill the gap from the top level, so set it in every environment or none",
    ]);
  });

  test("an inheritable @extra key set in one environment and not another: Wrangler would fill the gap", async () => {
    const extra = JSON.stringify({ observability: { enabled: true } });
    const oneEnvironment = editFixture(ENVS, (r) => {
      child(r, "deployment.worker", "siteProduction")["@extra"] = extra;
    });
    expect(await problems(oneEnvironment)).toEqual([
      "app.service acme::quiz::Quiz.site: @extra observability is set in production and not in staging; Wrangler would fill the gap from the top level, so set it in every environment or none",
    ]);
    const everyEnvironment = editFixture(ENVS, (r) => {
      child(r, "deployment.worker", "siteBase")["@extra"] = extra;
    });
    expect((await read(everyEnvironment)).deployments.map((d) => (d as WorkerDeployment).extra)).toEqual([
      { observability: { enabled: true } },
      { observability: { enabled: true } },
    ]);
  });

  test("a build-time secret setting and a build-time value.ref, each refused by its setting", async () => {
    const sources = editFixture(TRIPS, (r) => {
      children(child(r, "object.settings", "Notify")).push(
        { "field.string": { "name": "contentKey", "@envName": "CONTENT_API_KEY", "@secret": true, "@phase": "build" } },
        { "field.string": { "name": "apiBase", "@envName": "NOTIFY_API_BASE", "@phase": "build" } },
      );
      children(child(r, "deployment.worker", "webProduction")).push({ "value.ref": { name: "apiBase", "@setting": "Notify.apiBase", "@producedBy": "Trips.photos", "@output": "url" } });
    });
    expect(await problems(sources)).toEqual([
      "deployment.worker acme::trips::webProduction: acme::trips::Notify.contentKey (CONTENT_API_KEY) is @secret and @phase build; the scripts copy a secret to a Worker or to a Pages project, never to a build on this machine. Mark it @phase runtime if the Worker reads it; otherwise build by hand under keys-axi run and deploy with --no-build",
      "deployment.worker acme::trips::webProduction value.ref apiBase: Notify.apiBase is @phase build, and a build on the deploying machine has no reference to resolve; give it a value.literal or a @default",
    ]);
  });

  test("an @extra key the generator writes itself", async () => {
    const sources = editFixture(TRIPS, (r) => {
      child(r, "deployment.worker", "webProduction")["@extra"] = JSON.stringify({ vars: { X: "1" } });
    });
    expect(await problems(sources)).toEqual([
      "deployment.worker acme::trips::webProduction: @extra sets vars, which the generator writes from the model; declare those facts in the model",
    ]);
  });

  test("@jobs naming something that is not a scheduled app.job", async () => {
    const sources = editFixture(TRIPS, (r) => {
      child(r, "deployment.worker", "webProduction")["@jobs"] = ["Trips.web"];
    });
    expect(await problems(sources)).toEqual(['deployment.worker acme::trips::webProduction: @jobs "Trips.web" does not resolve to an app.job (write System.job)']);
  });

  test("no top-level environment: several environments, none named production", async () => {
    const sources = editFixture(ENVS, (r) => {
      child(r, "environment.standing", "production")["name"] = "live";
      child(r, "deployment.worker", "siteProduction")["@environment"] = "live";
      for (const c of children(child(r, "vault.infisical", "keys"))) if (c["scope.env"]?.["name"] === "production") c["scope.env"]["name"] = "live";
    });
    expect(await problems(sources)).toEqual([
      "app.service acme::quiz::Quiz.site deploys to live, staging, and none is named production: pass { topLevel } to the generators to say which environment `wrangler deploy` with no --env deploys",
    ]);
    const app = await read(sources, { topLevel: "live" });
    expect(app.deployments.map((d) => d.environment)).toEqual(["live", "staging"]);
  });

  test("two environments that would deploy over one Worker", async () => {
    const sources = editFixture(ENVS, (r) => {
      r["metadata.root"].children.push(
        { "environment.standing": { name: "qa" } },
        { "deployment.worker": { name: "siteQa", extends: "siteBase", "@environment": "qa", "@script": "quiz-staging" } },
      );
      children(child(r, "vault.infisical", "keys")).push({ "scope.env": { name: "qa", "@project": "quiz" } });
    });
    expect(await problems(sources)).toEqual(['deployment.worker acme::quiz::siteQa: deploys Worker "quiz-staging", as acme::quiz::siteStaging does; give one a different @script']);
  });

  test("a deploy-token vault with no scope for an environment and no @defaultScope", async () => {
    const sources = editFixture(ENVS, (r) => {
      delete child(r, "vault.infisical", "deployKeys")["@defaultScope"];
    });
    const got = await problems(sources);
    expect(got).toEqual([
      'deployment.worker acme::quiz::siteProduction: vault acme::quiz::deployKeys has no scope.env named "production" and no @defaultScope, so this environment has no place in it',
      'deployment.worker acme::quiz::siteStaging: vault acme::quiz::deployKeys has no scope.env named "staging" and no @defaultScope, so this environment has no place in it',
    ]);
  });

  test("a deploy token read from the @secrets vault: both deployments read it there, and that vault's problem is reported once", async () => {
    const fromSecrets = (r: Root): void => {
      delete child(r, "deployment.worker", "siteBase")["@tokenVault"];
    };
    const tokens = (await read(editFixture(ENVS, fromSecrets))).deployments.map((d) => [d.token.secret, d.token.place.key, `${d.token.place.scope.project}/${d.token.place.scope.env}`]);
    expect(tokens).toEqual([
      ["ACME_WORKERS_TOKEN", "acme::quiz::keys", "quiz/prod"],
      ["ACME_WORKERS_TOKEN", "acme::quiz::keys", "quiz/staging"],
    ]);
    const noStaging = editFixture(ENVS, (r) => {
      fromSecrets(r);
      const keys = child(r, "vault.infisical", "keys");
      keys["children"] = children(keys).filter((c) => c["scope.env"]?.["name"] !== "staging");
    });
    expect(await problems(noStaging)).toEqual([
      'deployment.worker acme::quiz::siteStaging: vault acme::quiz::keys has no scope.env named "staging" and no @defaultScope, so this environment has no place in it',
    ]);
  });

  test("one app deployed both as a Worker and as a Pages site", async () => {
    const sources = editFixture(ENVS, (r) => {
      r["metadata.root"].children.push(
        { "environment.standing": { name: "docs" } },
        { "deployment.pages": { name: "sitePages", "@app": "Quiz.site", "@environment": "docs", "@project": "quiz", "@tokenVault": "deployKeys", "@tokenSecret": "T" } },
      );
    });
    expect(await problems(sources)).toEqual([
      "app.service acme::quiz::Quiz.site is deployed both as a Worker and as a Pages site; deploy one app one way (a Worker with static assets replaces a Pages site)",
    ]);
  });

  test("two Cloudflare apps in one model: the generators need { app }", async () => {
    const both = [...editFixture(ENVS, () => {}), ...(await import("./model.js")).fixtureSources(TRIPS)];
    const got = await problems(both);
    expect(got).toEqual([
      "the model deploys 2 apps to Cloudflare (app.service acme::quiz::Quiz.site, app.service acme::trips::Trips.web); one wrangler.jsonc and one set of scripts are for one app, so pass { app } to the generators",
    ]);
    expect((await read(both, { app: "Trips.web" })).name).toBe("web");
  });
});

describe("a Pages site's environments", () => {
  const secretRow = "Secret values: `SEARCH_API_KEY`";

  test("a deployment serves Pages production when its branch is the production branch, else preview", async () => {
    const app = await read(editFixture(PAGES_SECRETS, () => {}));
    expect(app.deployments.map((d) => [d.environment, d.branch, (d as PagesDeployment).pagesEnvironment])).toEqual([
      ["production", "main", "production"],
      ["preview", "preview", "preview"],
    ]);
    expect(app.deployments.map((d) => d.unexpressed.find((f) => f.fact === secretRow)?.how)).toEqual([
      "Never in a file. deploy/cloudflare/sync-secrets.sh copies them from the vault scope `acme-help/prod`; deploy/cloudflare/doctor.sh checks the names are in the vault and on the Pages project's production environment.",
      "Never in a file. deploy/cloudflare/sync-secrets.sh copies them from the vault scope `acme-help-preview/preview`; deploy/cloudflare/doctor.sh checks the names are in the vault and on the Pages project's preview environment.",
    ]);
  });

  test("a deployment that reads a secret is refused when the model does not say which branch is production", async () => {
    const withoutProduction = (r: Root): void => {
      r["metadata.root"].children = r["metadata.root"].children.filter((c) => c["deployment.pages"]?.["@environment"] !== "production");
    };
    const noProduction = editFixture(PAGES_SECRETS, withoutProduction);
    expect(await problems(noProduction)).toEqual([
      'deployment.pages acme::help::sitePreview: site reads 1 secret setting(s) (SEARCH_API_KEY) and the model does not say whether this deployment serves the Pages project\'s production or its preview environment, each of which keeps its own: no deployment.pages of site in an environment named "production" declares a @branch, the project\'s production branch',
    ]);
    const noBranch = editFixture(PAGES_SECRETS, (r) => {
      delete child(r, "deployment.pages", "siteProduction")["@branch"];
    });
    expect(await problems(noBranch)).toEqual([
      "deployment.pages acme::help::siteProduction: site reads 1 secret setting(s) (SEARCH_API_KEY) and the model does not say whether this deployment serves the Pages project's production or its preview environment, each of which keeps its own: it has no @branch",
      'deployment.pages acme::help::sitePreview: site reads 1 secret setting(s) (SEARCH_API_KEY) and the model does not say whether this deployment serves the Pages project\'s production or its preview environment, each of which keeps its own: no deployment.pages of site in an environment named "production" declares a @branch, the project\'s production branch',
    ]);
    // With no secret to place, a deployment needs no Pages environment.
    const noSecrets = editFixture(PAGES_SECRETS, (r) => {
      withoutProduction(r);
      delete child(r, "deployment.pages", "siteBase")["@secrets"];
      for (const c of children(child(r, "object.settings", "Search"))) delete c["field.string"]!["@secret"];
    });
    expect((await read(noSecrets)).deployments.map((d) => (d as PagesDeployment).pagesEnvironment)).toEqual([undefined]);
  });

  test("two deployments that read secrets from differing vault scopes: refused when they serve one Pages project's environment, and free to serve the same one in two projects", async () => {
    const withStaging = (vault: (keys: Record<string, unknown>, scopes: Node[]) => void, staging: Record<string, unknown> = {}): ReturnType<typeof editFixture> =>
      editFixture(PAGES_SECRETS, (r) => {
        const keys = child(r, "vault.infisical", "keys");
        vault(keys, children(keys));
        r["metadata.root"].children.push(
          { "environment.standing": { "name": "staging" } },
          { "deployment.pages": { name: "siteStaging", extends: "siteBase", "@environment": "staging", "@branch": "staging", ...staging } },
        );
      });
    const served = (app: Awaited<ReturnType<typeof read>>) =>
      app.deployments.map((d) => [d.environment, (d as PagesDeployment).pagesEnvironment, d.vault === undefined ? undefined : `${d.vault.scope.project}/${d.vault.scope.env}`]);
    // One scope for both: the vault has no scope named preview, so that environment falls to the @defaultScope, which is the staging environment's own scope.
    const oneScope = withStaging((keys, scopes) => {
      keys["@defaultScope"] = "staging";
      for (const c of scopes) if (c["scope.env"]?.["@env"] === "preview") c["scope.env"] = { name: "staging", "@project": "acme-help-staging", "@env": "staging" };
    });
    expect(served(await read(oneScope))).toEqual([
      ["production", "production", "acme-help/prod"],
      ["preview", "preview", "acme-help-staging/staging"],
      ["staging", "preview", "acme-help-staging/staging"],
    ]);
    const sync = (await emit(await loadModels(oneScope))).get("deploy/cloudflare/sync-secrets.sh")!;
    expect(sync.match(/  staging\)\n    copy (.*)/)?.[1]).toBe("acme-help-staging staging SEARCH_API_KEY help-site preview");
    const ownScope = (scopes: Node[]): void => {
      scopes.push({ "scope.env": { name: "staging", "@project": "acme-help-staging", "@env": "staging" } });
    };
    expect(await problems(withStaging((_keys, scopes) => ownScope(scopes)))).toEqual([
      "deployment.pages acme::help::siteStaging: serves the preview environment of Pages project help-site, as acme::help::sitePreview does, and reads its secrets from vault acme::help::keys scope staging (acme-help-staging/staging), not from vault acme::help::keys scope preview (acme-help-preview/preview); Pages keeps one value per name in a project environment, so the last deploy overwrites the other's secrets: give both deployments one vault scope",
    ]);
    // Two projects keep separate secrets, so the same Pages environment in each is no clash.
    const ownProject = withStaging((_keys, scopes) => ownScope(scopes), { "@branch": "main", "@project": "help-site-staging" });
    expect(served(await read(ownProject))).toEqual([
      ["production", "production", "acme-help/prod"],
      ["preview", "preview", "acme-help-preview/preview"],
      ["staging", "production", "acme-help-staging/staging"],
    ]);
    expect((await emit(await loadModels(ownProject))).get("deploy/cloudflare/sync-secrets.sh")!.match(/  staging\)\n    copy (.*)/)?.[1]).toBe("acme-help-staging staging SEARCH_API_KEY help-site-staging production");
  });

  test("a value for a secret, for a setting the app does not read, or for no setting is refused on a Pages site as on a Worker; a valid one is listed", async () => {
    const value = (name: string, setting: string): Node => ({ "value.literal": { name, "@setting": setting, "@literal": "abc" } });
    const [valid, ...refused] = [value("base", "Search.baseUrl"), value("key", "Search.apiKey"), value("other", "Other.url"), value("nope", "Search.nope")];
    const withValues = (values: readonly Node[]): ReturnType<typeof editFixture> =>
      editFixture(PAGES_SECRETS, (r) => {
        r["metadata.root"].children.push({ "object.settings": { name: "Other", "children": [{ "field.string": { "name": "url", "@envName": "OTHER_URL" } }] } });
        children(child(r, "object.settings", "Search")).push({ "field.string": { "name": "baseUrl", "@envName": "SEARCH_BASE_URL" } });
        children(child(r, "deployment.pages", "siteProduction")).push(...values);
      });
    const where = "deployment.pages acme::help::siteProduction value.literal";
    expect(await problems(withValues([valid!, ...refused]))).toEqual([
      `${where} key: Search.apiKey is @secret; its value comes from the vault, never from a value node`,
      `${where} other: Other.url is not a setting of the groups site reads (@settings)`,
      `${where} nope: @setting "Search.nope" names no setting (Group.field) of an object.settings in the model`,
    ]);
    const production = (await read(withValues([valid!]))).deployments[0] as PagesDeployment;
    expect(production.unexpressed.map((f) => f.fact)).toEqual([
      "Secret values: `SEARCH_API_KEY`",
      "Non-secret settings `SEARCH_BASE_URL` (value nodes `base`)",
      "Custom domains `help.example.com`",
    ]);
  });
});
