// REFERENCE TEMPLATE — copy this into your repo (e.g. codegen/generators/requirements.ts) and own it.
// Then import it LOCALLY in metaobjects.config.ts:
//   import { requirementsFile } from "./codegen/generators/requirements.js";
//
// RUNTIME: this file executes under whatever runs `meta docs`, and the published CLI's
// shebang is `#!/usr/bin/env node` — so it runs under NODE even in a Bun project. Do not
// reach for `Bun.*` globals here; they are undefined and take the whole run down with
// `Bun is not defined`. Use `node:` builtins instead.
// targets:       Markdown for people and TOON for tools. Neither imports anything.
// use-when:      you want to change how `meta docs` writes the requirement ledger: which
//                files it writes, where they land, or what they hold. `meta docs` writes
//                them without this file; eject it only to change them.
// emits:         under `docs.outDir`: requirements.md, the human index, and
//                requirements.toon, the machine-readable form a drift gate can commit. A
//                project that declares no `requirement.*` node gets neither file.
// customize:     the file names, the output directory (`outDir`), and whether both forms are
//                written (`generate`). The two renderers and the projection they read
//                (`requirements-markdown`, `requirements-toon`, `requirements-view`) are
//                copied beside it into codegen/templates/.
// composes-with: agent-docs (its `requirements.md` page is built from the same projection).
//
// HOW IT RUNS. `meta docs` runs it, so it is listed in the docs block of
// metaobjects.config.ts, not among the generators `meta gen` runs:
//   docs: { generators: [requirementsFile()] }
// The `docsSurface` marker below says which surface it takes over: with it listed,
// `meta docs` and `meta verify --docs` run THIS generator for the requirements surface in
// place of the packaged one.
//
// Everything below imports the engine from `@metaobjectsdev/codegen-ts` and the renderers
// from `../generators/` — which `meta eject` copies into your project and points at your
// copy.
//
// METADATA ALONE. `meta docs` guarantees output "from metadata ALONE — no gen config, no
// codegen pipeline": this generator reads `ctx.loadedRoot` and NOTHING else. An EMPTY
// LEDGER EMITS ZERO FILES, not an empty page — that is what makes the surface safe to
// leave on for every project without a ledger. BOTH FILES, UNCONDITIONALLY: a drift gate
// wants the machine-readable artifact committed regardless of who ran it.

import {
  oncePerRun,
  type EmittedFile,
  type Generator,
  type GeneratorFactory,
} from "@metaobjectsdev/codegen-ts";
import { renderRequirementsMarkdown } from "../generators/requirements-markdown.js";
import { renderRequirementsToon } from "../generators/requirements-toon.js";
import { requirementRows } from "../generators/requirements-view.js";

/** The human-facing index. */
const MARKDOWN_FILENAME = "requirements.md";
/** The machine-facing artifact — see requirements-toon.ts for why TOON. */
const TOON_FILENAME = "requirements.toon";

export interface RequirementsFileOpts {
  /** Output directory prefix relative to the target's outDir. Default: "" (root). */
  outDir?: string;
  /** Optional named output target (registry key). Defaults to "default". */
  target?: string;
}

export const requirementsFile = function requirementsFile(
  opts?: RequirementsFileOpts,
): Generator {
  const dirPrefix = opts?.outDir ? `${opts.outDir.replace(/\/$/, "")}/` : "";

  const generator: Generator = {
    name: "requirements-file",
    // The surface this generator takes over when it is listed in `docs.generators`.
    docsSurface: "requirements",
    generate: oncePerRun((_entities, ctx) => {
      const rows = requirementRows(ctx.loadedRoot);
      // The one early return that matters. Both renderers also return "" for an empty
      // ledger, so this is belt-and-braces — but the guarantee callers depend on is
      // "zero FILES", which only this line can provide.
      if (rows.length === 0) return [];

      const files: EmittedFile[] = [
        { path: `${dirPrefix}${MARKDOWN_FILENAME}`, content: renderRequirementsMarkdown(rows) },
        { path: `${dirPrefix}${TOON_FILENAME}`, content: renderRequirementsToon(rows) },
      ];
      return files;
    }),
  };

  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<RequirementsFileOpts>;
