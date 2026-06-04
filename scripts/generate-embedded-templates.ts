#!/usr/bin/env bun
//
// generate-embedded-templates.ts
//
// Reads every canonical template GROUP under repo-root templates/*/ *.mustache
// (docs, api, …) and emits a plain-string TS module
//   server/typescript/packages/codegen-ts/src/render-engine/embedded-templates.generated.ts
// mapping the provider resolve ref (path under templates/ WITHOUT the .mustache
// suffix, e.g. "docs/entity-page.md" or "api/index.md") to the EXACT file
// contents. New groups are picked up automatically (glob templates/*/).
//
// WHY a generated string module (not a `.mustache` text-import): codegen-ts
// builds with `tsc`, which rejects unknown-extension text imports
// (`import x from "./f.mustache" with { type: "text" }`). A plain TS module of
// string literals compiles cleanly with tsc AND gets bundled into the
// `bun build --compile` standalone `meta` binary — so the framework doc
// templates resolve even where the on-disk templates/ dir is unavailable.
//
// Run via: bun run scripts/generate-embedded-templates.ts
// (also wired into scripts/sync-doc-templates.sh so one command keeps the
//  package copy AND this embedded module in sync with canonical.)
//
// A byte-identity drift test gates this output:
//   server/typescript/packages/codegen-ts/test/embedded-templates.test.ts

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the repo root relative to THIS script (walk up to the dir containing
// both templates/ and server/). No hardcoded absolute paths.
function findRepoRoot(start: string): string {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, "templates")) && existsSync(join(dir, "server"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("Could not locate repo root (dir containing templates/ and server/)");
    }
    dir = parent;
  }
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = findRepoRoot(scriptDir);

const templatesRoot = join(repoRoot, "templates");
const outFile = join(
  repoRoot,
  "server",
  "typescript",
  "packages",
  "codegen-ts",
  "src",
  "render-engine",
  "embedded-templates.generated.ts",
);

// Every template GROUP is a subdir of templates/ (docs, api, …). Glob each
// group's *.mustache so new groups are embedded automatically.
const groups = readdirSync(templatesRoot)
  .filter((g) => statSync(join(templatesRoot, g)).isDirectory())
  .sort();

// ref = path under templates/ WITHOUT the .mustache suffix, matching how
// FrameworkTemplatesProvider.resolve(ref) builds `<dir>/<ref>.mustache`.
// e.g. templates/docs/entity-page.md.mustache -> "docs/entity-page.md";
// templates/api/index.md.mustache -> "api/index.md".
// Sorted by ref for deterministic, byte-stable output.
const entries = groups
  .flatMap((group) => {
    const dir = join(templatesRoot, group);
    return readdirSync(dir)
      .filter((f) => f.endsWith(".mustache"))
      .map((file) => {
        const ref = `${group}/${file.slice(0, -".mustache".length)}`;
        const content = readFileSync(join(dir, file), "utf-8");
        return { ref, content };
      });
  })
  .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));

if (entries.length === 0) {
  console.error(`error: no *.mustache templates found under ${templatesRoot}/*/`);
  process.exit(1);
}

const body = entries
  // JSON.stringify emits a safe string literal — preserves newlines/quotes/
  // unicode byte-for-byte.
  .map((e) => `  ${JSON.stringify(e.ref)}: ${JSON.stringify(e.content)},`)
  .join("\n");

const source = `// @generated from templates/*/*.mustache — DO NOT EDIT.
// Regenerate: bun run scripts/generate-embedded-templates.ts (or scripts/sync-doc-templates.sh).
//
// Embedded framework doc templates so they resolve inside the
// \`bun build --compile\` standalone \`meta\` binary, where the on-disk
// \`templates/\` directory is unavailable. Keys are provider resolve refs
// (path under templates/ minus the .mustache suffix).
export const EMBEDDED_FRAMEWORK_TEMPLATES: Record<string, string> = {
${body}
};
`;

writeFileSync(outFile, source, "utf-8");
console.log(`generated ${outFile} (${entries.length} template(s): ${entries.map((e) => e.ref).join(", ")})`);
