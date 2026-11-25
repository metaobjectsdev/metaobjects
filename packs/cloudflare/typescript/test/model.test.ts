// What the model reader does with each fixture, and what it refuses: every refusal names the
// node, and every problem in a model is reported at once.
import { describe, expect, test } from "bun:test";
import { CloudflareModelError, parseGeneratedJsonc, readCloudflare, type WorkerDeployment } from "../src/index.js";
import { editFixture, emit, loadFixture, loadModels, type Source } from "./model.js";

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

test("loadFixture loads every success scenario", async () => {
  for (const s of [ENVS, TRIPS, "cloudflare-pages-site"]) expect((await loadFixture(s)).children().length).toBeGreaterThan(0);
});
