#!/usr/bin/env node
// A publish workflow publishes the version COMMITTED in its manifest, whatever tag started it.
// A `python-v1.1.1` tag pushed on a commit whose pyproject still says 1.1.0 would publish
// 1.1.0 (or fail half way, as a duplicate). This check runs first in each publish workflow and
// refuses the run when the tag that triggered it does not name the manifest's version.
//
//   node scripts/check-release-tag.mjs <npm|python|csharp|java> [<version override>]
//
// On a tag push (GITHUB_REF_TYPE=tag) the tag must be `<prefix>-v<manifest version>`, and a
// version override is refused (the tag is the version). On a manual run there is no tag to
// compare, so the check only reports what will be published.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * @typedef {{ prefix: string, file: string, read: (text: string) => string | undefined }} PortSpec
 * @typedef {"npm" | "python" | "csharp" | "java"} PortName
 */

/** Each publishing port: its tag prefix and how to read its committed version. @type {Record<PortName, PortSpec>} */
export const PORTS = {
  npm: {
    prefix: "npm",
    file: "server/typescript/packages/cli/package.json",
    read: (text) => /** @type {{ version?: string }} */ (JSON.parse(text)).version,
  },
  python: {
    prefix: "python",
    file: "server/python/pyproject.toml",
    read: (text) => /^version\s*=\s*"([^"]+)"/m.exec(text)?.[1],
  },
  csharp: {
    prefix: "csharp",
    file: "server/csharp/Directory.Build.props",
    read: (text) => /<Version>([^<]+)<\/Version>/.exec(text)?.[1],
  },
  java: {
    prefix: "java",
    file: "server/java/pom.xml",
    // The parent's own <version>, the first one after its <artifactId> (not the <parent>'s
    // or a dependency's): the reactor pom has no <parent>, so the first <version> is it.
    read: (text) => /<version>([^<]+)<\/version>/.exec(text)?.[1],
  },
};

/**
 * The verdict for one run. Pure, so the test drives it without a checkout or an environment.
 * Returns `{ ok: true, message }` or `{ ok: false, message }`.
 * @param {{ port: string | undefined, manifestVersion: string | undefined, refType: string | undefined, refName: string | undefined, override?: string }} run
 * @returns {{ ok: boolean, message: string }}
 */
export function checkReleaseTag({ port, manifestVersion, refType, refName, override }) {
  const spec = portSpec(port);
  if (spec === undefined) return { ok: false, message: `unknown port '${port}' (expected ${Object.keys(PORTS).join(", ")})` };
  if (!manifestVersion) return { ok: false, message: `no version found in ${spec.file}` };
  if (refType !== "tag") {
    const v = override || manifestVersion;
    return { ok: true, message: `manual run, no tag to compare: publishing ${port} ${v}` };
  }
  if (override) {
    return { ok: false, message: `a tag run takes its version from the tag; drop the version override '${override}'` };
  }
  const want = `${spec.prefix}-v${manifestVersion}`;
  if (refName !== want) {
    return {
      ok: false,
      message:
        `tag '${refName}' does not match ${spec.file}, which says ${manifestVersion}. ` +
        `Push '${want}', or commit the version the tag names before tagging.`,
    };
  }
  return { ok: true, message: `tag '${refName}' matches ${spec.file} (${manifestVersion})` };
}

/** @param {string | undefined} port @returns {PortSpec | undefined} */
function portSpec(port) {
  return port !== undefined && Object.hasOwn(PORTS, port) ? PORTS[/** @type {PortName} */ (port)] : undefined;
}

function main() {
  const [port, override = ""] = process.argv.slice(2);
  const spec = portSpec(port);
  const manifestVersion = spec === undefined ? undefined : spec.read(readFileSync(join(REPO, spec.file), "utf8"));
  const verdict = checkReleaseTag({
    port,
    manifestVersion,
    refType: process.env.GITHUB_REF_TYPE,
    refName: process.env.GITHUB_REF_NAME,
    override,
  });
  (verdict.ok ? console.log : console.error)(`${verdict.ok ? "✓" : "✗"} ${verdict.message}`);
  process.exit(verdict.ok ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
