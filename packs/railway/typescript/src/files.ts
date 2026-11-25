/**
 * The files beside `.railway/railway.ts`: the facts that file cannot hold, the scripts that
 * copy secrets to Railway, deploy and check, and the skill an agent follows to deploy.
 *
 * The scripts call `railway`, `keys-axi`, `jq`, `npm` and `curl`; MetaObjects writes them and
 * stops. A secret's value only ever passes from `keys-axi run`'s environment through a pipe
 * into `railway variable set --stdin`: no script prints one or puts one on a command line.
 */
import { RAILWAY_SDK_VERSION } from "./constants.js";
import { BUILD_SUBTYPE_STATIC } from "@metaobjectsdev/pack-delivery";
import type { RailwayDeployment, RailwayProject } from "./model.js";

/** A shell word: bare when it is safe, else single-quoted. */
function sh(s: string): string {
  return /^[A-Za-z0-9_./:@-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function md(s: string): string {
  return `\`${s}\``;
}

// ── deploy/unexpressed.md ────────────────────────────────────────────────────

interface Fact {
  readonly fact: string;
  readonly how: string;
}

/** The facts of one deployment `.railway/railway.ts` does not carry, and how each is carried instead. */
export function unexpressedFacts(d: RailwayDeployment, manageVariables: boolean): Fact[] {
  const out: Fact[] = [];
  const b = d.build;
  if (b?.context !== undefined && b.context !== "." && b.context !== "/") {
    out.push({
      fact: `Build context ${md(b.context)} (build.${b.kind})`,
      how: "Railway builds from the repository root; the file has no build context. Set the service's root directory in Railway, or build from the root.",
    });
  }
  if (b?.kind === BUILD_SUBTYPE_STATIC && b.directory !== undefined) {
    out.push({
      fact: `Static directory ${md(b.directory)} (build.static)`,
      how: "Railway has no setting that serves a directory of files. Serve it with a process (runtime.process @command), or deploy the app on a static host.",
    });
  }
  for (const p of d.processes.slice(1)) {
    out.push({
      fact: `Second process ${md(p.name)} (runtime.process)`,
      how: "A Railway service runs one process; the file declares the first. Run this one as its own app with its own deployment.",
    });
  }
  for (const r of d.resources) {
    const what = [r.engine, r.version].filter((x) => x !== undefined).join(" ");
    out.push({
      fact: `${r.kind} ${md(r.name)}${what === "" ? "" : ` (${what})`}`,
      how: `Not declared, so the partial neither creates nor deletes it. It must exist in the Railway project under the name ${md(r.name)}, which every reference to it uses.`,
    });
  }
  if (d.image !== undefined && d.branch !== undefined) {
    out.push({
      fact: `Branch ${md(d.branch)} (deployment.railway @branch)`,
      how: `The service's source is the image ${md(d.image)}, which has no branch to deploy from. The file leaves the branch out.`,
    });
  }
  if (d.image !== undefined && d.checkSuites !== undefined) {
    out.push({
      fact: `Check suites ${md(String(d.checkSuites))} (deployment.railway @checkSuites)`,
      how: `The service's source is the image ${md(d.image)}, which has no check suites to wait for. The file leaves the setting out.`,
    });
  }
  const port = d.processes.find((p) => p.port !== undefined)?.port;
  if (port !== undefined && d.domains.length === 0) {
    out.push({
      fact: `Port ${md(String(port))} (runtime.process @port)`,
      how: `The file carries a port only beside a domain, and this deployment has none. Railway takes the port from the service's PORT variable (or a domain's target port): set PORT=${port} on the service in Railway. References from other services to this port use the model's value.`,
    });
  }
  if (d.domains.length > 0) {
    out.push({
      fact: `DNS for ${d.domains.map(md).join(", ")}`,
      how: "The file attaches the domains to the service; the DNS record each needs (the CNAME Railway shows for it) is set at the DNS provider. deploy/doctor.sh checks each answers on the health path.",
    });
  }
  const secrets = d.secrets;
  if (secrets.length > 0 && d.vault !== undefined) {
    out.push({
      fact: `Secret values: ${secrets.map(md).join(", ")}`,
      how: `Never in the file. deploy/sync-secrets.sh ${d.environment} copies them from the vault scope ${md(`${d.vault.scope.project}/${d.vault.scope.env}`)}; deploy/doctor.sh checks the names are in the vault and on Railway.`,
    });
  }
  const plain = d.settings.filter((s) => !s.secret).map((s) => s.envName);
  if (!manageVariables && plain.length > 0) {
    out.push({
      fact: `Non-secret settings: ${plain.map(md).join(", ")}`,
      how: "The file leaves variables unmanaged, so these keep the value set on Railway (or the application's default). Declare a value.* node on the deployment to have the file manage variables.",
    });
  }
  return out;
}

export function renderUnexpressed(project: RailwayProject, header: string): string {
  const lines = [
    header,
    "",
    `# What \`.railway/railway.ts\` does not hold: Railway project ${md(project.name)}`,
    "",
    "Facts the model declares that Railway's Infrastructure as Code file cannot carry, or that this",
    "file leaves to something else, each with how it is carried instead. Generated from the model:",
    "change the model, not this file.",
  ];
  for (const d of project.deployments) {
    const facts = unexpressedFacts(d, project.manageVariables);
    lines.push("", `## ${d.service} in ${d.environment}`, "", `From deployment.railway ${md(d.key)}.`, "");
    if (facts.length === 0) {
      lines.push("Nothing: the file holds every fact the model declares for this deployment.");
      continue;
    }
    lines.push("| Fact | How it is carried |", "|---|---|");
    for (const f of facts) lines.push(`| ${f.fact} | ${f.how} |`);
  }
  return `${lines.join("\n")}\n`;
}

// ── shared shell pieces ──────────────────────────────────────────────────────

function shellHead(header: string, purpose: readonly string[], usage: string): string[] {
  return ["#!/usr/bin/env bash", header, ...purpose.map((l) => (l === "" ? "#" : `# ${l}`)), "#", `#   ${usage}`];
}

function caseBlock(project: RailwayProject, body: (ds: readonly RailwayDeployment[], env: string) => string[], usage: string): string[] {
  const lines = ['case "$ENVIRONMENT" in'];
  for (const env of project.environments) {
    const ds = project.deployments.filter((d) => d.environment === env);
    lines.push(`  ${sh(env)})`, ...body(ds, env).map((l) => `    ${l}`), "    ;;");
  }
  lines.push(`  *) echo ${sh(`usage: ${usage} (environments: ${project.environments.join(", ")})`)} >&2; exit 2 ;;`, "esac");
  return lines;
}

const ENSURE_SDK = [
  "ensure_sdk() {",
  `  [ -d .railway/node_modules/railway ] || npm install --no-save --prefix .railway railway@${RAILWAY_SDK_VERSION} >/dev/null`,
  "}",
];

// ── deploy/sync-secrets.sh ───────────────────────────────────────────────────

const SYNC_USAGE = "bash deploy/sync-secrets.sh <environment> [--dry-run]";

export function renderSyncSecrets(project: RailwayProject, header: string): string {
  const lines = [
    ...shellHead(
      header,
      [
        `Copies every secret setting the model declares from the vault to Railway project ${project.name},`,
        "for one environment. A value goes from keys-axi's environment through a pipe into",
        "`railway variable set --stdin`: it is never printed and never on a command line. It sets",
        "with --skip-deploys, so the next deploy picks the values up.",
        "",
        "Needs: keys-axi (an identity that may read the vault scope) and railway (logged in, run",
        "from the linked repository).",
      ],
      SYNC_USAGE,
    ),
    "set -euo pipefail",
    'cd "$(dirname "$0")/.."',
    "",
    'ENVIRONMENT="${1:-}"',
    "DRY_RUN=0",
    'for arg in "${@:2}"; do',
    '  case "$arg" in',
    "    --dry-run) DRY_RUN=1 ;;",
    `    *) echo ${sh(`usage: ${SYNC_USAGE}`)} >&2; exit 2 ;;`,
    "  esac",
    "done",
    "",
    "# copy <vault project> <vault environment> <railway service> <railway environment> <NAME>",
    "copy() {",
    '  if [ "$DRY_RUN" = 1 ]; then echo "would copy $5 from $1/$2 to service $3 ($4)"; return; fi',
    "  # shellcheck disable=SC2016 # the inner shell expands it: the value never enters this one",
    `  keys-axi run --project "$1" --env "$2" --only "$5" -- bash -c '`,
    `    [ -n "\${!1+set}" ] || { echo "sync-secrets: $1 is not in the vault scope" >&2; exit 1; }`,
    `    printf %s "\${!1}" | railway variable set "$1" --stdin --service "$2" --environment "$3" --skip-deploys >/dev/null`,
    `  ' sync-secret "$5" "$3" "$4"`,
    '  echo "copied $5 to service $3 ($4)"',
    "}",
    "",
    ...caseBlock(
      project,
      (ds, env) => {
        const body: string[] = [];
        for (const d of ds) {
          const secrets = d.secrets;
          if (secrets.length === 0 || d.vault === undefined) continue;
          for (const s of secrets) body.push(`copy ${sh(d.vault.scope.project)} ${sh(d.vault.scope.env)} ${sh(d.service)} ${sh(env)} ${s}`);
        }
        return body.length > 0 ? body : [`echo ${sh(`no secret settings to copy in ${env}`)}`];
      },
      SYNC_USAGE,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

// ── deploy/doctor.sh ─────────────────────────────────────────────────────────

const DOCTOR_USAGE = "bash deploy/doctor.sh <environment>";

function healthUrls(d: RailwayDeployment): string[] {
  const path = d.processes[0]?.healthPath;
  return path === undefined ? [] : d.domains.map((domain) => `https://${domain}${path}`);
}

export function renderDoctor(project: RailwayProject, header: string): string {
  const lines = [
    ...shellHead(
      header,
      [
        `Checks Railway project ${project.name} against the model, for one environment, by name only:`,
        "every secret the model declares is in the vault and on Railway; `.railway/railway.ts`",
        "matches what Railway runs (`railway config plan`); each domain answers on the health path.",
        "Exits 1 when a check fails. It prints names, never a value.",
        "",
        "Needs: railway (logged in, run from the linked repository), keys-axi, jq, npm, curl.",
      ],
      DOCTOR_USAGE,
    ),
    "set -uo pipefail",
    'cd "$(dirname "$0")/.." || exit 2',
    "",
    'ENVIRONMENT="${1:-}"',
    "FAIL=0",
    "ok() { echo \"ok   $*\"; }",
    "bad() { echo \"FAIL $*\"; FAIL=1; }",
    "for tool in railway keys-axi jq npm curl; do",
    '  command -v "$tool" >/dev/null || { echo "doctor: $tool is not installed" >&2; exit 2; }',
    "done",
    ...ENSURE_SDK,
    "",
    "# in_vault <vault project> <vault environment> <NAME>...",
    "in_vault() {",
    "  local names",
    `  names=$(keys-axi ls --project "$1" --env "$2" --json | jq -r '.secrets[].name') || { bad "cannot list vault scope $1/$2"; return; }`,
    "  local where=\"$1/$2\"; shift 2",
    '  for n in "$@"; do',
    '    if grep -qx "$n" <<<"$names"; then ok "$n is in the vault ($where)"; else bad "$n is declared secret and is not in the vault ($where)"; fi',
    "  done",
    "}",
    "",
    "# on_railway <service> <environment> <NAME>...",
    "on_railway() {",
    "  local names",
    `  names=$(railway variable list --service "$1" --environment "$2" --json | jq -r 'if type == "object" then keys[] else .[].name end') || { bad "cannot list the variables of service $1 ($2)"; return; }`,
    "  local where=\"service $1 ($2)\"; shift 2",
    '  for n in "$@"; do',
    '    if grep -qx "$n" <<<"$names"; then ok "$n is set on $where"; else bad "$n is declared and not set on $where (run deploy/sync-secrets.sh)"; fi',
    "  done",
    "}",
    "",
    "# plan_clean <environment>: the file matches Railway",
    "plan_clean() {",
    '  railway environment "$1" >/dev/null || { bad "cannot link Railway environment $1"; return; }',
    "  ensure_sdk || { bad \"cannot install the railway SDK into .railway\"; return; }",
    "  railway config plan --detailed-exit-code >/dev/null 2>&1",
    "  case $? in",
    '    0) ok ".railway/railway.ts matches Railway ($1)" ;;',
    '    2) bad ".railway/railway.ts differs from Railway ($1): run deploy/deploy.sh $1" ;;',
    '    *) bad "railway config plan failed ($1): run it by hand to see why" ;;',
    "  esac",
    "}",
    "",
    // Only when some domain is checked: shellcheck flags a function nothing calls.
    ...(project.deployments.some((d) => healthUrls(d).length > 0)
      ? [
          "# answers <url>",
          "answers() {",
          '  if curl -fsS -o /dev/null --max-time 10 "$1"; then ok "$1 answers"; else bad "$1 does not answer 2xx"; fi',
          "}",
          "",
        ]
      : []),
    ...caseBlock(
      project,
      (ds, env) => {
        const body: string[] = [];
        for (const d of ds) {
          if (d.secrets.length > 0 && d.vault !== undefined) {
            body.push(`in_vault ${sh(d.vault.scope.project)} ${sh(d.vault.scope.env)} ${d.secrets.join(" ")}`);
            body.push(`on_railway ${sh(d.service)} ${sh(env)} ${d.secrets.join(" ")}`);
          }
        }
        body.push(`plan_clean ${sh(env)}`);
        for (const d of ds) for (const url of healthUrls(d)) body.push(`answers ${sh(url)}`);
        return body;
      },
      DOCTOR_USAGE,
    ),
    "",
    'exit "$FAIL"',
  ];
  return `${lines.join("\n")}\n`;
}

// ── deploy/deploy.sh ─────────────────────────────────────────────────────────

const DEPLOY_USAGE = "bash deploy/deploy.sh <environment> [--yes] [--redeploy]";

export function renderDeploy(project: RailwayProject, header: string): string {
  const lines = [
    ...shellHead(
      header,
      [
        `Deploys Railway project ${project.name} to one environment from the model:`,
        "  1. copies the secrets from the vault (deploy/sync-secrets.sh),",
        "  2. plans and applies `.railway/railway.ts` (`railway config plan`, then `apply`),",
        "  3. with --redeploy, redeploys each service and waits for its health path,",
        "  4. runs deploy/doctor.sh.",
        "A push to the deployment's branch also deploys on Railway; this script is for settings and",
        "secrets, and for a deploy that cannot wait for a push. --yes applies without the prompt",
        "(never a destructive change: Railway refuses one without --confirm-destructive).",
        "",
        "Needs: railway (logged in, run from the linked repository), keys-axi, jq, npm, curl.",
      ],
      DEPLOY_USAGE,
    ),
    "set -euo pipefail",
    'cd "$(dirname "$0")/.."',
    "",
    'ENVIRONMENT="${1:-}"',
    'YES=""; REDEPLOY=0',
    'for arg in "${@:2}"; do',
    '  case "$arg" in',
    "    --yes) YES=--yes ;;",
    "    --redeploy) REDEPLOY=1 ;;",
    `    *) echo ${sh(`usage: ${DEPLOY_USAGE}`)} >&2; exit 2 ;;`,
    "  esac",
    "done",
    ...ENSURE_SDK,
    "",
    "# wait_healthy <url> <seconds>",
    "wait_healthy() {",
    '  local deadline=$((SECONDS + $2))',
    '  until curl -fsS -o /dev/null --max-time 10 "$1"; do',
    '    [ "$SECONDS" -lt "$deadline" ] || { echo "deploy: $1 did not answer 2xx within $2 seconds" >&2; return 1; }',
    "    sleep 10",
    "  done",
    '  echo "healthy: $1"',
    "}",
    "",
    "# settle <environment>: sync secrets, then plan and apply the file",
    "settle() {",
    '  bash deploy/sync-secrets.sh "$1"',
    '  railway environment "$1" >/dev/null',
    "  ensure_sdk",
    "  railway config plan",
    "  # shellcheck disable=SC2086 # YES is empty or one word",
    "  railway config apply $YES",
    "}",
    "",
    ...caseBlock(
      project,
      (ds, env) => {
        const body = [`settle ${sh(env)}`, 'if [ "$REDEPLOY" = 1 ]; then'];
        for (const d of ds) {
          body.push(`  railway redeploy --service ${sh(d.service)} --yes`);
          const wait = d.processes[0]?.healthTimeoutSeconds ?? 300;
          for (const url of healthUrls(d)) body.push(`  wait_healthy ${sh(url)} ${wait}`);
        }
        body.push("fi", `bash deploy/doctor.sh ${sh(env)}`);
        return body;
      },
      DEPLOY_USAGE,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

// ── the deploy skill ─────────────────────────────────────────────────────────

export function renderDeploySkill(project: RailwayProject, header: string): string {
  const services = [...new Set(project.deployments.map((d) => d.service))];
  const rows = project.deployments.map((d) => {
    const secrets = d.secrets;
    const vault = d.vault === undefined ? "none" : md(`${d.vault.scope.project}/${d.vault.scope.env}`);
    return `| ${md(d.environment)} | ${md(d.service)} | ${d.branch === undefined ? "none" : md(d.branch)} | ${d.domains.length === 0 ? "none" : d.domains.map(md).join(", ")} | ${vault} (${secrets.length} secret${secrets.length === 1 ? "" : "s"}) |`;
  });
  const lines = [
    "---",
    "name: deploy",
    `description: Deploy Railway project ${project.name} (${services.join(", ")}) to ${project.environments.join(" or ")} from the generated deploy scripts. Use when asked to deploy, ship to Railway, rotate a secret on Railway, or check a Railway deployment.`,
    "---",
    "",
    header,
    "",
    `# Deploy ${project.name} to Railway`,
    "",
    "Generated from the model (railway pack). Every deploy fact lives in the model; the files in",
    "`.railway/` and `deploy/` are written from it. To change a deploy setting, change the model and",
    "regenerate, never the generated files.",
    "",
    "| Environment | Service | Deploys on push to | Domains | Secrets from |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    "## Before the first deploy",
    "",
    "- `railway login`, then `railway link` in the repository (it writes `.railway/config.json`).",
    "- A `keys-axi` identity that may read each vault scope above (`keys-axi` with no arguments shows it).",
    "- `jq`, `npm` and `curl` on the path.",
    "- If the service still has a Config as Code file (`railway.json` or `railway.toml`): Railway",
    "  stops reading it on 2026-12-01. Run `railway config migrate cutover` before the first plan, and",
    "  delete the old file only after cutover and the first apply.",
    "",
    "## Deploy",
    "",
    "1. `bash deploy/doctor.sh <environment>` to see where things stand. It prints names, never values.",
    "2. `bash deploy/sync-secrets.sh <environment> --dry-run` to see which secrets will be copied.",
    "3. `bash deploy/deploy.sh <environment>`: copies the secrets, shows the plan of `.railway/railway.ts`",
    "   and applies it after confirmation. Read the plan before confirming: stop if it deletes a",
    "   service, a database or a volume. Add `--redeploy` to redeploy now and wait for the health",
    "   check instead of waiting for the next push.",
    "4. `bash deploy/doctor.sh <environment>` again. Every line should be `ok`.",
    "",
    "## Rules",
    "",
    "- Never print a secret value, put one on a command line, or paste one into a file. The vault is",
    "  the source of truth: rotate a key there, then run `deploy/sync-secrets.sh`.",
    "- Never pass `--confirm-destructive` without a person's explicit go-ahead for that plan.",
    "- A fact Railway's file cannot hold is listed in `deploy/unexpressed.md` with how it is carried.",
    "",
  ];
  return lines.join("\n");
}
