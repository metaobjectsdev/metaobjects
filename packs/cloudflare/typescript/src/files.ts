/**
 * The files beside `wrangler.jsonc`: the token wrapper every Wrangler call goes through, the
 * scripts that deploy, copy secrets and check, and the facts the configuration cannot hold.
 *
 * Every Wrangler call runs through `wrangler.sh`, which reads the deployment's narrow API token
 * from the vault with `keys-axi run`, unsets the global-key variables (which Wrangler would
 * otherwise prefer) and any token the shell already holds, maps the vault's token to
 * CLOUDFLARE_API_TOKEN and runs a pinned wrangler. A secret's
 * value only ever passes from `keys-axi run`'s environment through a pipe into
 * `wrangler secret put`: no script prints one or puts one on a command line.
 */
import { posix } from "node:path";
import { ACCOUNT_ID_SECRET, API_TOKEN_VARIABLE, CLEARED_VARIABLES, DEPLOYMENT_SUBTYPE_PAGES, GLOBAL_KEY_VARIABLES } from "./constants.js";
import type { CloudflareApp, CloudflareDeployment, UnexpressedFact } from "./model.js";

/** Where each generated file lives, relative to the repository root, and the pinned wrangler. */
export interface CloudflarePaths {
  readonly config: string;
  readonly runner: string;
  readonly deploy: string;
  readonly syncSecrets: string;
  readonly doctor: string;
  readonly unexpressed: string;
  readonly wranglerVersion: string;
}

/** A shell word: bare when it is safe, else single-quoted. */
export function sh(s: string): string {
  return /^[A-Za-z0-9_./:@=,+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function md(s: string): string {
  return `\`${s}\``;
}

/** `cd` from the script's directory to the repository root. */
function cdRoot(scriptPath: string): string {
  const depth = posix.normalize(scriptPath).split("/").length - 1;
  return depth === 0 ? 'cd "$(dirname "$0")"' : `cd "$(dirname "$0")/${Array(depth).fill("..").join("/")}"`;
}

function shellHead(header: string, purpose: readonly string[], usage: string): string[] {
  return ["#!/usr/bin/env bash", header, ...purpose.map((l) => (l === "" ? "#" : `# ${l}`)), "#", `#   ${usage}`];
}

function environments(app: CloudflareApp): string[] {
  return app.deployments.map((d) => d.environment);
}

function caseBlock(app: CloudflareApp, body: (d: CloudflareDeployment) => string[], usage: string): string[] {
  const lines = ['case "$ENVIRONMENT" in'];
  for (const d of app.deployments) lines.push(`  ${sh(d.environment)})`, ...body(d).map((l) => `    ${l}`), "    ;;");
  lines.push(`  *) echo ${sh(`usage: ${usage} (environments: ${environments(app).join(", ")})`)} >&2; exit 2 ;;`, "esac");
  return lines;
}

/** The arguments that point a Worker command at this environment's block of the configuration. */
function workerTarget(app: CloudflareApp, d: CloudflareDeployment, paths: CloudflarePaths): string {
  return [`--config ${sh(paths.config)}`, ...(d.environment === app.topLevel ? [] : [`--env ${sh(d.environment)}`])].join(" ");
}

// ── deploy/cloudflare/wrangler.sh ────────────────────────────────────────────

export function renderRunner(app: CloudflareApp, header: string, paths: CloudflarePaths): string {
  const usage = `bash ${paths.runner} <environment> <wrangler arguments>...`;
  const lines = [
    ...shellHead(
      header,
      [
        `Runs wrangler ${paths.wranglerVersion} (WRANGLER_VERSION overrides) for ${app.appKey}, as the narrow`,
        "Cloudflare API token of one environment's deployment. The token and CLOUDFLARE_ACCOUNT_ID are read",
        `from the vault with keys-axi. The global-key variables (${GLOBAL_KEY_VARIABLES.join(", ")}) are unset`,
        `so Wrangler cannot fall back to them, and so is any ${API_TOKEN_VARIABLE} the shell holds; the vault's token then becomes ${API_TOKEN_VARIABLE}.`,
        "",
        "Needs: keys-axi (KEYS_AXI overrides where it is) and npx.",
      ],
      usage,
    ),
    "set -euo pipefail",
    cdRoot(paths.runner),
    "",
    'ENVIRONMENT="${1:-}"',
    '[ "$#" -gt 0 ] && shift',
    `WRANGLER_VERSION="\${WRANGLER_VERSION:-${paths.wranglerVersion}}"`,
    'KEYS_AXI="${KEYS_AXI:-$(command -v keys-axi || echo "$HOME/.local/bin/keys-axi")}"',
    "",
    ...caseBlock(
      app,
      (d) => [`VAULT_PROJECT=${sh(d.token.place.scope.project)} VAULT_ENV=${sh(d.token.place.scope.env)} TOKEN=${sh(d.token.secret)}`],
      usage,
    ),
    "",
    "# shellcheck disable=SC2016 # the inner shell expands them: the token never enters this one",
    `exec env ${CLEARED_VARIABLES.map((v) => `-u ${v}`).join(" ")} \\`,
    `  "$KEYS_AXI" run --project "$VAULT_PROJECT" --env "$VAULT_ENV" --only "$TOKEN" ${ACCOUNT_ID_SECRET} -- \\`,
    "  bash -c '",
    "    set -euo pipefail",
    '    [ -n "${!1+set}" ] || { echo "wrangler.sh: the deploy token $1 is not in the vault scope" >&2; exit 1; }',
    `    export ${API_TOKEN_VARIABLE}="\${!1}"`,
    `    [ "$1" = ${API_TOKEN_VARIABLE} ] || unset "$1"`,
    `    : "\${${ACCOUNT_ID_SECRET}:?${ACCOUNT_ID_SECRET} is not in the vault scope}"`,
    '    version="$2"',
    "    shift 2",
    '    exec npx --yes "wrangler@$version" "$@"',
    `  ' wrangler "$TOKEN" "$WRANGLER_VERSION" "$@"`,
  ];
  return `${lines.join("\n")}\n`;
}

// ── deploy/cloudflare/sync-secrets.sh ────────────────────────────────────────

export function renderSyncSecrets(app: CloudflareApp, header: string, paths: CloudflarePaths): string {
  const usage = `bash ${paths.syncSecrets} <environment> [--dry-run]`;
  const pages = app.kind === DEPLOYMENT_SUBTYPE_PAGES;
  const put = pages ? 'pages secret put "$1" --project-name "$3" --env "$4"' : 'secret put "$1" $3';
  const lines = [
    ...shellHead(
      header,
      [
        ...(pages
          ? [
              `Copies every secret setting ${app.appKey} reads from the vault to the Pages project's environment,`,
              "for one environment: production when its branch is the project's production branch, else preview.",
            ]
          : [`Copies every secret setting ${app.appKey} reads from the vault to Cloudflare, for one environment.`]),
        `A value goes from keys-axi's environment through a pipe into \`wrangler ${pages ? "pages secret put" : "secret put"}\`:`,
        "it is never printed and never on a command line.",
        "",
        `Needs: keys-axi (an identity that may read the vault scope) and what ${paths.runner} needs.`,
      ],
      usage,
    ),
    "set -euo pipefail",
    cdRoot(paths.syncSecrets),
    "",
    'ENVIRONMENT="${1:-}"',
    "DRY_RUN=0",
    'for arg in "${@:2}"; do',
    '  case "$arg" in',
    "    --dry-run) DRY_RUN=1 ;;",
    `    *) echo ${sh(`usage: ${usage}`)} >&2; exit 2 ;;`,
    "  esac",
    "done",
    'KEYS_AXI="${KEYS_AXI:-$(command -v keys-axi || echo "$HOME/.local/bin/keys-axi")}"',
    "",
    `# copy <vault project> <vault environment> <NAME> <${pages ? "Pages project> <Pages environment" : "wrangler target arguments"}>`,
    "copy() {",
    pages
      ? '  if [ "$DRY_RUN" = 1 ]; then echo "would copy $3 from $1/$2 to Pages project $4, $5 environment ($ENVIRONMENT)"; return; fi'
      : '  if [ "$DRY_RUN" = 1 ]; then echo "would copy $3 from $1/$2 to Cloudflare ($ENVIRONMENT)"; return; fi',
    "  # shellcheck disable=SC2016 # the inner shell expands it: the value never enters this one",
    '  "$KEYS_AXI" run --project "$1" --env "$2" --only "$3" -- bash -c \'',
    '    [ -n "${!1+set}" ] || { echo "sync-secrets: $1 is not in the vault scope" >&2; exit 1; }',
    '    value="${!1}"',
    '    unset "$1"',
    `    printf %s "$value" | bash ${sh(paths.runner)} "$2" ${put} >/dev/null`,
    `  ' sync-secret "$3" "$ENVIRONMENT" "$4"${pages ? ' "$5"' : ""}`,
    pages
      ? '  echo "copied $3 to Pages project $4, $5 environment ($ENVIRONMENT)"'
      : '  echo "copied $3 to Cloudflare ($ENVIRONMENT)"',
    "}",
    "",
    ...caseBlock(
      app,
      (d) => {
        if (d.secrets.length === 0 || d.vault === undefined) return [`echo ${sh(`no secret settings to copy in ${d.environment}`)}`];
        const target = d.kind === DEPLOYMENT_SUBTYPE_PAGES ? `${sh(d.project)} ${sh(d.pagesEnvironment!)}` : sh(workerTarget(app, d, paths));
        return d.secrets.map((s) => `copy ${sh(d.vault!.scope.project)} ${sh(d.vault!.scope.env)} ${s} ${target}`);
      },
      usage,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

// ── deploy/cloudflare/deploy.sh ──────────────────────────────────────────────

export function renderDeploy(app: CloudflareApp, header: string, paths: CloudflarePaths): string {
  const pages = app.kind === DEPLOYMENT_SUBTYPE_PAGES;
  const build = app.deployments[0]?.build;
  const builds = build?.command !== undefined;
  const usage = `bash ${paths.deploy} <environment>${builds ? " [--no-build]" : ""} [--no-secrets]`;
  const anyBuildVar = app.deployments.some((d) => d.buildVars.length > 0);
  const lines = [
    ...shellHead(
      header,
      [
        `Deploys ${app.appKey} to one environment, from the model:`,
        ...[
          ...(build?.command === undefined ? [] : [`builds it (\`${build.command}\`, skipped with --no-build),`]),
          `copies its secrets from the vault (${paths.syncSecrets}, skipped with --no-secrets),`,
          pages
            ? "uploads the build to the environment's Pages project and branch, recording the commit."
            : `runs \`wrangler deploy\` with the environment's block of ${paths.config}.`,
        ].map((step, i) => `  ${i + 1}. ${step}`),
        ...(anyBuildVar
          ? builds
            ? ["Build-time settings are read by the build from this machine's environment; the values the model gives", "are exported first, and a value already in the environment wins."]
            : [
                `Build-time settings are read from this machine's environment by whatever builds ${app.name}; deploy.sh runs no`,
                "build (the app declares no build command), and exports the values the model gives first; a value already",
                "in the environment wins.",
              ]
          : []),
        "",
        `Needs: what ${paths.runner} needs${pages ? ", and git" : ""}.`,
      ],
      usage,
    ),
    "set -euo pipefail",
    cdRoot(paths.deploy),
    "",
    'ENVIRONMENT="${1:-}"',
    builds ? "BUILD=1; SECRETS=1" : "SECRETS=1",
    'for arg in "${@:2}"; do',
    '  case "$arg" in',
    ...(builds ? ["    --no-build) BUILD=0 ;;"] : []),
    "    --no-secrets) SECRETS=0 ;;",
    `    *) echo ${sh(`usage: ${usage}`)} >&2; exit 2 ;;`,
    "  esac",
    "done",
    ...(anyBuildVar
      ? caseBlock(app, (d) => (d.buildVars.length === 0 ? [":"] : d.buildVars.flatMap((v) => [`# ${v.from}`, `[ -n "\${${v.name}:-}" ] || export ${v.name}=${sh(v.value)}`])), usage)
      : [`case "$ENVIRONMENT" in ${environments(app).map(sh).join("|")}) ;; *) echo ${sh(`usage: ${usage} (environments: ${environments(app).join(", ")})`)} >&2; exit 2 ;; esac`]),
    "",
    ...(build?.command === undefined
      ? []
      : ['if [ "$BUILD" = 1 ]; then', `  # ${build.from} @command`, `  ${build.command}`, "fi"]),
    `if [ "$SECRETS" = 1 ]; then bash ${sh(paths.syncSecrets)} "$ENVIRONMENT"; fi`,
    "",
    ...caseBlock(
      app,
      (d) =>
        d.kind === DEPLOYMENT_SUBTYPE_PAGES
          ? [
              `bash ${sh(paths.runner)} "$ENVIRONMENT" pages deploy ${sh(d.directory)} --project-name=${sh(d.project)}${d.branch === undefined ? "" : ` --branch=${sh(d.branch)}`} --commit-hash="$(git rev-parse HEAD)"`,
            ]
          : [`bash ${sh(paths.runner)} "$ENVIRONMENT" deploy ${workerTarget(app, d, paths)}`],
      usage,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

// ── deploy/cloudflare/doctor.sh ──────────────────────────────────────────────

export function renderDoctor(app: CloudflareApp, header: string, paths: CloudflarePaths): string {
  const usage = `bash ${paths.doctor} <environment>`;
  const pages = app.kind === DEPLOYMENT_SUBTYPE_PAGES;
  const anyDomain = app.deployments.some((d) => d.domains.length > 0);
  const anySecret = app.deployments.some((d) => d.secrets.length > 0 && d.vault !== undefined);
  const lines = [
    ...shellHead(
      header,
      [
        `Checks ${app.appKey} on Cloudflare against the model, for one environment, by name only:`,
        "the deploy token and account id are in the vault; every secret the model declares is in the vault",
        pages ? "and on the Pages project's environment its branch serves (production or preview); each domain answers." : `and on the Worker; ${paths.config} builds (\`wrangler deploy --dry-run\`); each domain answers.`,
        "Exits 1 when a check fails. It prints names, never a value.",
        "",
        `Needs: keys-axi, jq, curl, and what ${paths.runner} needs.`,
      ],
      usage,
    ),
    "set -uo pipefail",
    `${cdRoot(paths.doctor)} || exit 2`,
    "",
    'ENVIRONMENT="${1:-}"',
    "FAIL=0",
    'ok() { echo "ok   $*"; }',
    'bad() { echo "FAIL $*"; FAIL=1; }',
    'KEYS_AXI="${KEYS_AXI:-$(command -v keys-axi || echo "$HOME/.local/bin/keys-axi")}"',
    '[ -x "$KEYS_AXI" ] || { echo "doctor: keys-axi is not installed" >&2; exit 2; }',
    "for tool in jq curl npx; do",
    '  command -v "$tool" >/dev/null || { echo "doctor: $tool is not installed" >&2; exit 2; }',
    "done",
    "",
    "# in_vault <vault project> <vault environment> <NAME>...",
    "in_vault() {",
    "  local names",
    `  names=$("$KEYS_AXI" ls --project "$1" --env "$2" --json | jq -r '.secrets[].name') || { bad "cannot list vault scope $1/$2"; return; }`,
    '  local where="$1/$2"; shift 2',
    '  for n in "$@"; do',
    '    if grep -Fxq -e "$n" <<<"$names"; then ok "$n is in the vault ($where)"; else bad "$n is not in the vault ($where)"; fi',
    "  done",
    "}",
    "",
    ...(anySecret
      ? pages
        ? [
            "# on_cloudflare <Pages project> <Pages environment> <NAME>...",
            "on_cloudflare() {",
            "  local names",
            `  names=$(bash ${sh(paths.runner)} "$ENVIRONMENT" pages secret list --project-name "$1" --env "$2" 2>/dev/null | sed -n 's/^ *- \\([A-Za-z0-9_]*\\):.*/\\1/p') || { bad "cannot list the secrets of Pages project $1, $2 environment"; return; }`,
            '  local where="Pages project $1, $2 environment"; shift 2',
            '  for n in "$@"; do',
            `    if grep -Fxq -e "$n" <<<"$names"; then ok "$n is set on $where"; else bad "$n is declared and not set on $where (run ${paths.syncSecrets})"; fi`,
            "  done",
            "}",
            "",
          ]
        : [
            "# on_cloudflare '<wrangler target arguments>' <NAME>...",
            "on_cloudflare() {",
            "  local names",
            "  # shellcheck disable=SC2086 # the target arguments are words",
            `  names=$(bash ${sh(paths.runner)} "$ENVIRONMENT" secret list $1 --format json | jq -r '.[].name') || { bad "cannot list the Worker's secrets"; return; }`,
            "  shift",
            '  for n in "$@"; do',
            `    if grep -Fxq -e "$n" <<<"$names"; then ok "$n is set on the Worker"; else bad "$n is declared and not set on the Worker (run ${paths.syncSecrets})"; fi`,
            "  done",
            "}",
            "",
          ]
      : []),
    ...(pages
      ? []
      : [
          "# builds '<wrangler target arguments>': the configuration and the Worker bundle build",
          "builds() {",
          "  local out",
          '  out=$(mktemp -d)',
          "  # shellcheck disable=SC2086 # the target arguments are words",
          `  if bash ${sh(paths.runner)} "$ENVIRONMENT" deploy --dry-run --outdir "$out" $1 >/dev/null 2>&1; then ok "${paths.config} builds ($ENVIRONMENT)"; else bad "${paths.config} does not build ($ENVIRONMENT): run wrangler deploy --dry-run to see why"; fi`,
          '  rm -rf "$out"',
          "}",
          "",
        ]),
    ...(anyDomain
      ? [
          "# answers <url>",
          "answers() {",
          '  if curl -fsS -o /dev/null --max-time 10 "$1"; then ok "$1 answers"; else bad "$1 does not answer 2xx"; fi',
          "}",
          "",
        ]
      : []),
    ...caseBlock(
      app,
      (d) => {
        const body = [`in_vault ${sh(d.token.place.scope.project)} ${sh(d.token.place.scope.env)} ${sh(d.token.secret)} ${ACCOUNT_ID_SECRET}`];
        if (d.secrets.length > 0 && d.vault !== undefined) {
          body.push(`in_vault ${sh(d.vault.scope.project)} ${sh(d.vault.scope.env)} ${d.secrets.join(" ")}`);
          body.push(`on_cloudflare ${d.kind === DEPLOYMENT_SUBTYPE_PAGES ? `${sh(d.project)} ${sh(d.pagesEnvironment!)}` : sh(workerTarget(app, d, paths))} ${d.secrets.join(" ")}`);
        }
        if (d.kind !== DEPLOYMENT_SUBTYPE_PAGES) body.push(`builds ${sh(workerTarget(app, d, paths))}`);
        for (const domain of d.domains) body.push(`answers ${sh(`https://${domain}/`)}`);
        return body;
      },
      usage,
    ),
    "",
    'exit "$FAIL"',
  ];
  return `${lines.join("\n")}\n`;
}

// ── deploy/cloudflare/unexpressed.md ─────────────────────────────────────────

export function renderUnexpressed(app: CloudflareApp, header: string, paths: CloudflarePaths): string {
  const [what, verb] = app.kind === DEPLOYMENT_SUBTYPE_PAGES ? ["the deploy scripts", "do not hold"] : [md(paths.config), "does not hold"];
  const lines = [
    header,
    "",
    `# What ${what} ${verb}: ${app.appKey}`,
    "",
    "Facts the model declares that Cloudflare's configuration cannot carry, or that it leaves to",
    "something else, each with how it is carried instead. Generated from the model: change the",
    "model, not this file.",
  ];
  for (const d of app.deployments) {
    const facts: readonly UnexpressedFact[] = d.unexpressed;
    lines.push("", `## ${d.environment}`, "", `From deployment.${d.kind} ${md(d.key)}.`, "");
    if (facts.length === 0) {
      lines.push("Nothing: the generated files hold every fact the model declares for this deployment.");
      continue;
    }
    lines.push("| Fact | How it is carried |", "|---|---|");
    for (const f of facts) lines.push(`| ${f.fact} | ${f.how} |`);
  }
  return `${lines.join("\n")}\n`;
}
