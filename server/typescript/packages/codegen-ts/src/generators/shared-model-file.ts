// FR-023 §4.3 — sharedModelFile(): the publisher's flattened shared-model artifact.
//
// A publisher project wires this generator to select a subset of its own metadata
// (by the same include/exclude scope-pattern grammar `scope` already uses) and emit
// it as ONE canonical-JSON `metadata.root` document plus a manifest — the artifact a
// consumer's `meta deps sync` copies into its own repo (design §2.2, §3.2, §3.5).
//
// This file only wires the run into the two stages that ARE the artifact, both in
// `src/shared-model/build-shared-model.ts`: `buildSharedModel` (load, select, closure,
// serialize, core-vocabulary re-load) and `renderSharedModelFiles` (the artifact, its
// hash and the manifest). What is decided here is what belongs to the publishing project:
// which of its source files may contribute and which version is published. The reference
// template an adopter ejects (`src/reference/shared-model.ts`) is this file against the
// package's public exports, held byte-identical by `test/reference-byte-identical.test.ts`.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { oncePerRun, type Generator, type GenContext, type EmittedFile } from "../generator.js";
import { buildSharedModel, renderSharedModelFiles } from "../shared-model/build-shared-model.js";

// Re-exported from here because `generators/index.ts` has always served them from this
// module (as `SHARED_MODEL_*`) for the `cli` parity test against sdk's canonical copies.
export { MANIFEST_FILE, ARTIFACT_SUFFIX, INTEGRITY_PREFIX } from "../shared-model/build-shared-model.js";

export interface SharedModelFileOpts {
  /** The dependency key a consumer will `meta deps sync` under. Also the artifact's
   *  basename: emits `<name>.metaobjects.json`. */
  name: string;
  /** Scope-pattern include list (the same `acme::platform::**` grammar as `scope`). */
  include: readonly string[];
  /** Applied after `include`. */
  exclude?: readonly string[];
  /** Which of the publisher's own source files may contribute. Default: the run's
   *  own source files (`ctx.sourceFiles` — everything `files?` narrows). */
  files?: readonly string[];
  /** The published version. Default: the nearest `package.json` `version` walking
   *  up from the project (`ctx.inputRoot`). */
  version?: string;
  /** Named output target, as on every other generator. */
  target?: string;
}

/** design §2.2 — "version defaults to the host package's version". Walks up from
 *  `startDir` for the nearest `package.json` carrying a string `version`. */
function nearestPackageVersion(startDir: string): string | undefined {
  let dir = startDir;
  for (let i = 0; i < 64; i++) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: unknown };
        if (typeof pkg.version === "string") return pkg.version;
      } catch {
        // An unparsable package.json is not a version source — keep walking up.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

export function sharedModelFile(opts: SharedModelFileOpts): Generator {
  const generator: Generator = {
    name: "shared-model",
    generate: oncePerRun(async (_entities, ctx: GenContext): Promise<EmittedFile[]> => {
      const files = opts.files ?? ctx.sourceFiles ?? [];
      if (files.length === 0) {
        throw new Error(
          `sharedModelFile("${opts.name}"): no source files to load — pass \`files\`, or run ` +
            `through \`meta gen\`, which supplies the project's own files as \`ctx.sourceFiles\`.`,
        );
      }

      const model = await buildSharedModel({
        name: opts.name,
        files,
        include: opts.include,
        ...(opts.exclude !== undefined ? { exclude: opts.exclude } : {}),
        ...(ctx.registry !== undefined ? { registry: ctx.registry } : {}),
      });

      // Resolved after the selection has passed every check, so a model that cannot be
      // published says so before a missing version does.
      const version = opts.version ?? nearestPackageVersion(ctx.inputRoot ?? ctx.projectRoot ?? process.cwd());
      if (version === undefined) {
        throw new Error(
          `sharedModelFile("${opts.name}"): no version available — pass \`version\` explicitly, ` +
            `or run inside a project with a package.json version at or above the project root.`,
        );
      }

      const { artifact, manifest } = renderSharedModelFiles(model, version);
      return [artifact, manifest];
    }),
  };
  if (opts.target !== undefined) generator.target = opts.target;
  return generator;
}
