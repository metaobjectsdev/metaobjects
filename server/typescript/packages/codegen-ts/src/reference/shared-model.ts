// REFERENCE TEMPLATE — copy this into your repo (e.g. codegen/generators/shared-model.ts) and own it.
// Then import it LOCALLY in metaobjects.config.ts:
//   import { sharedModelFile } from "./codegen/generators/shared-model.js";
//   generators: [sharedModelFile({ name, include })]
//
// RUNTIME: this file executes under whatever runs `meta gen`, and the published CLI's
// shebang is `#!/usr/bin/env node` — so it runs under NODE even in a Bun project. Do not
// reach for `Bun.*` globals here; they are undefined and take the whole run down with
// `Bun is not defined`. Use `node:` builtins instead.
// targets:       a consumer project's `meta deps sync`. The two emitted files import
//                nothing: one canonical-JSON `metadata.root` document and the manifest that
//                pins it by sha256.
// use-when:      this project PUBLISHES part of its model for other projects to depend on,
//                and you want the artifact their `meta deps sync` copies and verifies
//                instead of pointing them at your source files.
// emits:         <target>/<name>.metaobjects.json (the selected nodes, `extends` preserved)
//                and <target>/metaobjects.pkg.json (name, version, metamodelVersion, the
//                artifact's file name and hash, the packages and nodes it holds).
// customize:     which of your source files may contribute (`files`, default the run's
//                own), where the published version comes from (`nearestPackageVersion`
//                below reads the nearest package.json; swap it for your own source of
//                truth) and where the files land (`target`). Copied beside it, so yours
//                too: `buildSharedModel`, which loads the files, selects by `include` /
//                `exclude` (never `requirement.*` or `template.*`), refuses a selection
//                that is not closed or that needs vocabulary a consumer does not ship, and
//                serializes it; and `renderSharedModelFiles`, which names the two files,
//                hashes the artifact and writes the manifest. Those are what a consumer's
//                sync checks, so a copy that changed them would publish something a
//                consumer refuses, or accepts and cannot load: change them only if you
//                mean to stop agreeing with every consumer.
// composes-with: nothing. It reads your metadata files, not another generator's output.
//
// Everything below imports the engine from `@metaobjectsdev/codegen-ts` (the generator base) and
// the artifact builder from `../shared-model/`. `meta eject` copies that module into your
// project, under `codegen/templates/`, and your copy of this file imports it from there: it is
// yours too.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  perModel,
  type EmittedFile,
  type GenContext,
  type Generator,
} from "@metaobjectsdev/codegen-ts/engine";
import { buildSharedModel, renderSharedModelFiles } from "../shared-model/build-shared-model.js";

export interface SharedModelFileOpts {
  /** The dependency key a consumer will `meta deps sync` under. Also the artifact's
   *  basename: emits `<name>.metaobjects.json`. */
  name: string;
  /** Scope-pattern include list (the same `acme::platform::**` grammar as `scope`). */
  include: readonly string[];
  /** Applied after `include`. */
  exclude?: readonly string[];
  /** Which of the publisher's own source files may contribute. Default: the run's
   *  own source files (`ctx.sourceFiles`). */
  files?: readonly string[];
  /** The published version. Default: the nearest `package.json` `version` walking
   *  up from the project (`ctx.inputRoot`). */
  version?: string;
  /** Named output target, as on every other generator. */
  target?: string;
}

/** OWNED: where the published version comes from when the `version` option is absent.
 *  Walks up from `startDir` for the nearest `package.json` carrying a string `version`. */
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
    generate: perModel(async (_entities, ctx: GenContext): Promise<EmittedFile[]> => {
      // OWNED: which of your source files may contribute.
      const files = opts.files ?? ctx.sourceFiles ?? [];
      if (files.length === 0) {
        throw new Error(
          `sharedModelFile("${opts.name}"): no source files to load — pass \`files\`, or run through \`meta gen\`, which supplies the project's own files as \`ctx.sourceFiles\`.`,
        );
      }

      // The package's half: load, select, closure, serialize, core-vocabulary re-load.
      const model = await buildSharedModel({
        name: opts.name,
        files,
        include: opts.include,
        ...(opts.exclude !== undefined ? { exclude: opts.exclude } : {}),
        ...(ctx.registry !== undefined ? { registry: ctx.registry } : {}),
      });

      // OWNED: the version the manifest carries. Resolved after the selection has passed
      // every check, so a model that cannot be published says so before a missing version does.
      const version = opts.version ?? nearestPackageVersion(ctx.inputRoot ?? ctx.projectRoot ?? process.cwd());
      if (version === undefined) {
        throw new Error(
          `sharedModelFile("${opts.name}"): no version available — pass \`version\` explicitly, or run inside a project with a package.json version at or above the project root.`,
        );
      }

      // The package's half: the artifact, its hash and the manifest, as `meta deps sync` reads them.
      const { artifact, manifest } = renderSharedModelFiles(model, version);
      return [artifact, manifest];
    }),
  };
  if (opts.target !== undefined) generator.target = opts.target;
  return generator;
}
