// The Rust crates' part of a release (ADR-0065 Amendment 3): whether this cut publishes them,
// in what order, and the version edit that puts them on the shared line.
//
// Pure functions, so `scripts/test-rust-release.mjs` can hold every rule to cases;
// `scripts/release.mjs` supplies what git, cargo and crates.io answer.
//
// The rules are the ones every registry already follows (docs/RELEASING.md):
//
// - Publish what changed. The crates publish only when a file they ship changed since the last
//   `rust-v<version>` tag, and adopt the shared version when they do, skipping the numbers they
//   sat out. With no such tag the crates have never shipped, so the cut publishes them.
// - A change to `expected-registry.json` (the vocabulary every port byte-matches) publishes
//   every registry, the crates included, changed file or not.
// - The crates publish in dependency order, each after the crates it depends on, because
//   crates.io refuses a crate whose dependency is not yet there.

/** The workspace that holds the crates, relative to the repository root. */
export const RUST_DIR = "server/rust";

/** The tag a release cuts for the crates: `rust-v1.3.0`. */
export const RUST_TAG_PREFIX = "rust-v";

/** The manifest whose change makes every registry publish. */
export const EXPECTED_REGISTRY = "fixtures/registry-conformance/expected-registry.json";

/** What a crate directory holds that is not shipped in it: tests, examples, benches, baselines. */
const NOT_SHIPPED = new Set(["tests", "examples", "benches", "baselines"]);

/**
 * Whether a repository path is part of what the Rust crates ship: a crate's sources, build
 * script, data, manifest, README or licence, or the workspace manifest and lockfile. A
 * crate's tests, examples, benches and benchmark baselines are not.
 */
export function isRustProductPath(path) {
  const prefix = `${RUST_DIR}/`;
  if (!path.startsWith(prefix)) return false;
  const parts = path.slice(prefix.length).split("/");
  if (parts.length === 1) return parts[0] === "Cargo.toml" || parts[0] === "Cargo.lock";
  return !NOT_SHIPPED.has(parts[1]);
}

/** `1.3.0` or `1.3.0-rc.2` as numbers to compare: a final release sorts after its candidates. */
function versionKey(v) {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? Infinity : Number(m[4])];
}

function compareKeys(a, b) {
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/** The newest `rust-v*` tag among `tags`, or null when the crates have never been tagged. */
export function newestRustTag(tags) {
  let best = null;
  for (const t of tags) {
    if (!t.startsWith(RUST_TAG_PREFIX)) continue;
    const key = versionKey(t.slice(RUST_TAG_PREFIX.length));
    if (key && (best === null || compareKeys(key, best.key) > 0)) best = { tag: t, key };
  }
  return best?.tag ?? null;
}

/**
 * Whether this cut publishes the crates.
 *
 * @param {{lastTag: string|null, changedPaths: string[], mode?: "auto"|"publish"|"skip"}} input
 *   `changedPaths` are the repository paths changed since `lastTag` (ignored without one);
 *   `mode` is the release's `--crates` choice, `auto` unless the person cutting it overrode.
 * @returns {{publish: boolean, reason: string}}
 */
export function rustPublishDecision({ lastTag, changedPaths, mode = "auto" }) {
  if (mode === "publish") return { publish: true, reason: "--crates=publish" };
  if (mode === "skip") return { publish: false, reason: "--crates=skip" };
  if (mode !== "auto") throw new Error(`unknown --crates mode "${mode}" (auto, publish or skip)`);
  if (lastTag === null) return { publish: true, reason: "the crates have never been published" };
  if (changedPaths.includes(EXPECTED_REGISTRY)) {
    return { publish: true, reason: `${EXPECTED_REGISTRY} changed since ${lastTag}, which publishes every registry` };
  }
  const shipped = changedPaths.filter(isRustProductPath);
  if (shipped.length > 0) {
    const more = shipped.length > 3 ? ` and ${shipped.length - 3} more` : "";
    return { publish: true, reason: `changed since ${lastTag}: ${shipped.slice(0, 3).join(", ")}${more}` };
  }
  return { publish: false, reason: `no file the crates ship changed since ${lastTag}` };
}

/**
 * The publishable workspace crates in the order they must publish: each after every crate it
 * depends on. `metadata` is what `cargo metadata --format-version 1 --no-deps` prints. A
 * dev-dependency does not order anything: cargo leaves one without a version out of the
 * published manifest, and one with a version needs only to exist by the time someone runs
 * the crate's tests. Ties break on the name, so the order is the same on every machine.
 *
 * @throws when the crates depend on each other in a cycle.
 */
export function rustPublishOrder(metadata) {
  const members = new Set(metadata.workspace_members ?? []);
  const crates = metadata.packages.filter(
    (p) => (members.size === 0 || members.has(p.id)) && !(Array.isArray(p.publish) && p.publish.length === 0),
  );
  const names = new Set(crates.map((p) => p.name));
  const needs = new Map(crates.map((p) => [p.name, new Set(
    p.dependencies
      .filter((d) => d.kind !== "dev" && names.has(d.name) && d.name !== p.name)
      .map((d) => d.name),
  )]));
  const order = [];
  while (needs.size > 0) {
    const ready = [...needs].filter(([, deps]) => [...deps].every((d) => !needs.has(d))).map(([n]) => n).sort();
    if (ready.length === 0) {
      throw new Error(`the Rust crates depend on each other in a cycle: ${[...needs.keys()].sort().join(", ")}`);
    }
    for (const n of ready) { order.push(n); needs.delete(n); }
  }
  return order;
}

/**
 * A crate manifest with every version the release sets moved to `version`: the
 * `[workspace.package]` version, and the version requirement on each dependency given by
 * `path` (a sibling crate). Nothing else in the text changes.
 */
export function bumpRustManifest(text, version) {
  let out = "";
  let section = "";
  for (const line of text.split(/(?<=\n)/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) section = header[1].trim();
    let next = line;
    if (section === "workspace.package") next = next.replace(/^(\s*version\s*=\s*")[^"]*(")/, `$1${version}$2`);
    if (/\bpath\s*=/.test(next)) next = next.replace(/(\bversion\s*=\s*")[^"]*(")/, `$1${version}$2`);
    out += next;
  }
  return out;
}

/**
 * Whether crates.io already holds `version` of a crate, from the JSON its
 * `/api/v1/crates/<name>` endpoint answers. A crate that does not exist answers 404, which
 * the caller reads as free before calling this.
 */
export function crateVersionTaken(json, version) {
  return (json.versions ?? []).some((v) => v.num === version);
}
