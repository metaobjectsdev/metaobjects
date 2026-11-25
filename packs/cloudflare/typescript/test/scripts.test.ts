// The generated scripts run for real here. Each tool a script calls that talks to the outside
// is replaced by a stub first on PATH, and each stub writes what it was given under $STUB_DIR:
//   keys-axi  logs `<command> --project <P> --env <E> --only <names>` per call; `ls --json`
//             lists the names the fake vault holds, less $STUB_MISSING; `run` gives every
//             `--only` name a value of its own (`value-of-<NAME>`), but $STUB_MISSING, then
//             runs the command
//   npx       logs its arguments, its environment and its stdin; `secret list` lists the names
//   curl      fails when $STUB_CURL_FAIL is 1
// jq is the real one: the doctor reads the stubs' JSON through it.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { editFixture, emit, emitFixture, loadModels } from "./model.js";

const LIST = `held() {
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    [ "$n" = "\${STUB_MISSING:-}" ] || "$@"
  done < "$STUB_NAMES"
}`;

const STUBS: Readonly<Record<string, string>> = {
  "keys-axi": `#!/usr/bin/env bash
${LIST}
sub="$1"
project="" scope="" names=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --project) project="$2"; shift 2 ;;
    --env) scope="$2"; shift 2 ;;
    --only) shift; while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do names+=("$1"); shift; done ;;
    --) shift; break ;;
    *) shift ;;
  esac
done
echo "$sub --project $project --env $scope --only \${names[*]}" >> "$STUB_DIR/keys-axi.log"
if [ "$sub" = ls ]; then
  out='{"secrets":[' sep=""
  name() { out="$out$sep{\\"name\\":\\"$n\\"}"; sep=","; }
  held name
  echo "$out]}"
  exit 0
fi
for n in "\${names[@]}"; do
  [ "$n" = "\${STUB_MISSING:-}" ] || export "$n=value-of-$n"
done
exec "$@"
`,
  npx: `#!/usr/bin/env bash
${LIST}
echo "npx $*" >> "$STUB_DIR/npx.log"
env | sort > "$STUB_DIR/npx.env"
cat >> "$STUB_DIR/npx.stdin"
case "$*" in
  *" secret list"*" --format json")
    out="[" sep=""
    one() { out="$out$sep{\\"name\\":\\"$n\\",\\"type\\":\\"secret\\"}"; sep=","; }
    held one
    echo "$out]" ;;
  *" secret list"*)
    one() { echo "  - $n: secret"; }
    held one ;;
esac
`,
  curl: `#!/usr/bin/env bash
[ "\${STUB_CURL_FAIL:-0}" = 1 ] && exit 22
exit 0
`,
};

/** One run of a generated script: its exit, its output, and what the stubs were given. */
interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Every call of `tool`, each as it logged itself. */
  readonly calls: (tool: "npx" | "keys-axi") => string[];
  /** Each `keys-axi run` as the vault project, the vault environment and the names it was asked for. */
  readonly vaultRuns: () => string[][];
  /** The environment the last npx call ran in. */
  readonly npxEnv: () => Record<string, string>;
  /** Everything piped into every npx call, in order. */
  readonly npxStdin: () => string;
}

const staged: string[] = [];
afterAll(() => {
  for (const dir of staged) rmSync(dir, { recursive: true, force: true });
});

/** A directory holding `files` at their paths, the stubs in `bin/` and a fake vault of `names`. */
async function stage(files: ReadonlyMap<string, string>, names: readonly string[]): Promise<string> {
  const dir = mkdtempSync(join(process.env.DEV_SCRATCH ?? tmpdir(), "pack-cloudflare-scripts-"));
  staged.push(dir);
  for (const [path, content] of files) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content, { mode: 0o755 });
  }
  mkdirSync(join(dir, "bin"));
  for (const [tool, script] of Object.entries(STUBS)) writeFileSync(join(dir, "bin", tool), script, { mode: 0o755 });
  writeFileSync(join(dir, "names"), `${names.join("\n")}\n`);
  return dir;
}

function run(dir: string, script: string, args: readonly string[], env: Record<string, string> = {}): Run {
  const stubDir = join(dir, "stub");
  rmSync(stubDir, { recursive: true, force: true });
  mkdirSync(stubDir, { recursive: true });
  mkdirSync(join(dir, "tmp"), { recursive: true });
  const res = spawnSync("bash", [join(dir, script), ...args], {
    encoding: "utf8",
    input: "",
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
      HOME: dir,
      TMPDIR: join(dir, "tmp"),
      STUB_DIR: stubDir,
      STUB_NAMES: join(dir, "names"),
      CLOUDFLARE_EMAIL: "someone@example.com",
      CLOUDFLARE_API_KEY: "the-global-key",
      CLOUDFLARE_API_TOKEN: "the-shells-token",
      ...env,
    },
  });
  const written = (file: string): string => {
    try {
      return readFileSync(join(stubDir, file), "utf8");
    } catch {
      return "";
    }
  };
  const lines = (file: string): string[] =>
    written(file)
      .split("\n")
      .filter((l) => l !== "");
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    calls: (tool) => lines(`${tool}.log`),
    vaultRuns: () =>
      lines("keys-axi.log")
        .filter((l) => l.startsWith("run "))
        .map((l) => /^run --project (\S+) --env (\S+) --only (.*)$/.exec(l)!.slice(1)),
    npxEnv: () =>
      Object.fromEntries(
        lines("npx.env").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
      ),
    npxStdin: () => written("npx.stdin"),
  };
}

const TRIPS = "cloudflare-worker-cron-ratelimits";
const PAGES_SECRETS = "cloudflare-pages-secrets";
const RUNNER = "deploy/cloudflare/wrangler.sh";
const SYNC = "deploy/cloudflare/sync-secrets.sh";
const DOCTOR = "deploy/cloudflare/doctor.sh";
const ACCOUNT_ID = "CLOUDFLARE_ACCOUNT_ID";
/** The trips fixture's deploy token, in its own vault scope, and its five Worker secrets. */
const TRIPS_TOKEN = "ACME_WORKERS_TOKEN";
const TRIPS_SECRETS = ["SESSION_SECRET", "RESEND_API_KEY", "PASSPHRASE_PEPPER", "RECOVERY_ENC_KEY", "RECOVERY_HMAC_KEY"];
/** The doctor reads JSON with jq, which the stubs do not replace. */
const HAS_JQ = spawnSync("jq", ["--version"]).status === 0;
const doctorTest = HAS_JQ ? test : test.skip;
const findings = (r: Run): string[] => r.stdout.split("\n").filter((l) => l.startsWith("FAIL"));

describe("deploy/cloudflare/wrangler.sh", () => {
  test("runs the pinned wrangler as the vault's token, with the global key and the shell's token gone", async () => {
    const dir = await stage(await emitFixture(TRIPS), [TRIPS_TOKEN, ACCOUNT_ID]);
    const r = run(dir, RUNNER, ["production", "deploy", "--config", "wrangler.jsonc"]);
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
    expect(r.calls("npx")).toEqual(["npx --yes wrangler@4.168.0 deploy --config wrangler.jsonc"]);
    expect(r.vaultRuns()).toEqual([["acme-deploy", "dev", `${TRIPS_TOKEN} ${ACCOUNT_ID}`]]);
    const env = r.npxEnv();
    expect({ token: env["CLOUDFLARE_API_TOKEN"], account: env[ACCOUNT_ID] }).toEqual({
      token: `value-of-${TRIPS_TOKEN}`,
      account: `value-of-${ACCOUNT_ID}`,
    });
    expect(env[TRIPS_TOKEN]).toBeUndefined();
    expect(env["CLOUDFLARE_EMAIL"]).toBeUndefined();
    expect(env["CLOUDFLARE_API_KEY"]).toBeUndefined();
  });

  test("stops before wrangler, naming what the vault scope lacks", async () => {
    const dir = await stage(await emitFixture(TRIPS), [ACCOUNT_ID]);
    const noToken = run(dir, RUNNER, ["production", "deploy"], { STUB_MISSING: TRIPS_TOKEN });
    expect({ status: noToken.status, npx: noToken.calls("npx") }).toEqual({ status: 1, npx: [] });
    expect(noToken.stderr).toContain(`the deploy token ${TRIPS_TOKEN} is not in the vault scope`);
    const noAccount = run(dir, RUNNER, ["production", "deploy"], { STUB_MISSING: ACCOUNT_ID });
    expect({ status: noAccount.status, npx: noAccount.calls("npx") }).toEqual({ status: 1, npx: [] });
    expect(noAccount.stderr).toContain(`${ACCOUNT_ID} is not in the vault scope`);
  });
});

describe("deploy/cloudflare/sync-secrets.sh", () => {
  test("pipes each secret from its vault scope to `wrangler secret put`: the value on no command line and in no output", async () => {
    const dir = await stage(await emitFixture(TRIPS), [TRIPS_TOKEN, ACCOUNT_ID, ...TRIPS_SECRETS]);
    const r = run(dir, SYNC, ["production"]);
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
    expect(r.calls("npx")).toEqual(TRIPS_SECRETS.map((n) => `npx --yes wrangler@4.168.0 secret put ${n} --config wrangler.jsonc`));
    expect(r.npxStdin()).toBe(TRIPS_SECRETS.map((n) => `value-of-${n}`).join(""));
    expect(r.vaultRuns()).toEqual(
      TRIPS_SECRETS.flatMap((n) => [
        ["trips", "prod", n],
        ["acme-deploy", "dev", `${TRIPS_TOKEN} ${ACCOUNT_ID}`],
      ]),
    );
    expect(r.stdout).toBe(TRIPS_SECRETS.map((n) => `copied ${n} to Cloudflare (production)\n`).join(""));
    for (const text of [r.stdout, r.stderr, ...r.calls("npx"), ...r.calls("keys-axi")]) expect(text).not.toContain("value-of-");
  });

  test("stops at the first secret the vault scope lacks, before wrangler", async () => {
    const dir = await stage(await emitFixture(TRIPS), [TRIPS_TOKEN, ACCOUNT_ID, TRIPS_SECRETS[0]!]);
    const r = run(dir, SYNC, ["production"], { STUB_MISSING: TRIPS_SECRETS[1]! });
    expect({ status: r.status, stderr: r.stderr, npx: r.calls("npx"), stdout: r.stdout }).toEqual({
      status: 1,
      stderr: `sync-secrets: ${TRIPS_SECRETS[1]!} is not in the vault scope\n`,
      npx: [`npx --yes wrangler@4.168.0 secret put ${TRIPS_SECRETS[0]} --config wrangler.jsonc`],
      stdout: `copied ${TRIPS_SECRETS[0]} to Cloudflare (production)\n`,
    });
  });
});

describe("deploy/cloudflare/doctor.sh, for a Worker", () => {
  doctorTest("checks the token, each secret, the build and each domain by name, and a failing check fails the run", async () => {
    const dir = await stage(await emitFixture(TRIPS), [TRIPS_TOKEN, ACCOUNT_ID, ...TRIPS_SECRETS]);
    const ok = run(dir, DOCTOR, ["production"]);
    expect({ status: ok.status, stderr: ok.stderr, stdout: ok.stdout }).toEqual({
      status: 0,
      stderr: "",
      stdout: [
        `ok   ${TRIPS_TOKEN} is in the vault (acme-deploy/dev)`,
        `ok   ${ACCOUNT_ID} is in the vault (acme-deploy/dev)`,
        ...TRIPS_SECRETS.map((n) => `ok   ${n} is in the vault (trips/prod)`),
        ...TRIPS_SECRETS.map((n) => `ok   ${n} is set on the Worker`),
        "ok   wrangler.jsonc builds (production)",
        "ok   https://trips.example.com/ answers",
        "ok   https://www.trips.example.com/ answers",
        "",
      ].join("\n"),
    });
    expect(ok.calls("npx")).toEqual([
      "npx --yes wrangler@4.168.0 secret list --config wrangler.jsonc --format json",
      expect.stringMatching(/^npx --yes wrangler@4\.168\.0 deploy --dry-run --outdir \S+ --config wrangler\.jsonc$/),
    ]);
    const down = run(dir, DOCTOR, ["production"], { STUB_CURL_FAIL: "1" });
    expect({ status: down.status, findings: findings(down) }).toEqual({
      status: 1,
      findings: ["FAIL https://trips.example.com/ does not answer 2xx", "FAIL https://www.trips.example.com/ does not answer 2xx"],
    });
  });
});

describe("a Pages site's secrets", () => {
  const TOKEN = "ACME_PAGES_TOKEN";
  const VAULT = [TOKEN, ACCOUNT_ID, "SEARCH_API_KEY"];

  test.each([
    ["production", "acme-help", "prod", "production"],
    ["preview", "acme-help-preview", "preview", "preview"],
  ] as const)("sync-secrets.sh %s copies from vault scope %s/%s to the Pages %s environment", async (environment, project, scope, pagesEnvironment) => {
    const dir = await stage(await emitFixture(PAGES_SECRETS), VAULT);
    const r = run(dir, SYNC, [environment]);
    expect(r.calls("npx")).toEqual([`npx --yes wrangler@4.168.0 pages secret put SEARCH_API_KEY --project-name help-site --env ${pagesEnvironment}`]);
    expect(r.npxStdin()).toBe("value-of-SEARCH_API_KEY");
    expect(r.vaultRuns()).toEqual([
      [project, scope, "SEARCH_API_KEY"],
      ["acme-deploy", "dev", `${TOKEN} ${ACCOUNT_ID}`],
    ]);
    expect(r.stdout).toBe(`copied SEARCH_API_KEY to Pages project help-site, ${pagesEnvironment} environment (${environment})\n`);
    const dry = run(dir, SYNC, [environment, "--dry-run"]);
    expect({ stdout: dry.stdout, npx: dry.calls("npx"), keysAxi: dry.calls("keys-axi") }).toEqual({
      stdout: `would copy SEARCH_API_KEY from ${project}/${scope} to Pages project help-site, ${pagesEnvironment} environment (${environment})\n`,
      npx: [],
      keysAxi: [],
    });
  });

  doctorTest("doctor.sh checks the secrets against the Pages environment the deployment serves, and fails by name", async () => {
    const dir = await stage(await emitFixture(PAGES_SECRETS), VAULT);
    const ok = run(dir, DOCTOR, ["preview"]);
    expect({ status: ok.status, stderr: ok.stderr, stdout: ok.stdout }).toEqual({
      status: 0,
      stderr: "",
      stdout: [
        `ok   ${TOKEN} is in the vault (acme-deploy/dev)`,
        `ok   ${ACCOUNT_ID} is in the vault (acme-deploy/dev)`,
        "ok   SEARCH_API_KEY is in the vault (acme-help-preview/preview)",
        "ok   SEARCH_API_KEY is set on Pages project help-site, preview environment",
        "",
      ].join("\n"),
    });
    expect(ok.calls("npx")).toEqual(["npx --yes wrangler@4.168.0 pages secret list --project-name help-site --env preview"]);
    const missing = run(dir, DOCTOR, ["preview"], { STUB_MISSING: "SEARCH_API_KEY" });
    expect({ status: missing.status, findings: findings(missing) }).toEqual({
      status: 1,
      findings: [
        "FAIL SEARCH_API_KEY is not in the vault (acme-help-preview/preview)",
        "FAIL SEARCH_API_KEY is declared and not set on Pages project help-site, preview environment (run deploy/cloudflare/sync-secrets.sh)",
      ],
    });
  });

  doctorTest("doctor.sh passes a token name to the vault as one literal word, whatever it holds", async () => {
    const token = "ACME PAGES *TOKEN";
    const sources = editFixture(PAGES_SECRETS, (r) => {
      for (const c of r["metadata.root"].children) if (c["deployment.pages"]?.["name"] === "siteBase") c["deployment.pages"]!["@tokenSecret"] = token;
    });
    const dir = await stage(await emit(await loadModels(sources)), [token, ACCOUNT_ID, "SEARCH_API_KEY"]);
    const r = run(dir, DOCTOR, ["preview"]);
    expect(r.stdout).toContain(`ok   ${token} is in the vault (acme-deploy/dev)\n`);
    expect(r.stdout).not.toContain("FAIL ACME ");
    expect(r.stdout).not.toContain("FAIL PAGES ");
  });
});
