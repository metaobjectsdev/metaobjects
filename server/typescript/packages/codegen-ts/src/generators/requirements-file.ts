// server/typescript/packages/codegen-ts/src/generators/requirements-file.ts
//
// The `requirements` docs surface generator — emits the ledger as documentation.
//
// Design: docs/superpowers/specs/2026-08-21-requirements-doc-surface-design.md
//
// METADATA ALONE. `meta docs` guarantees output "from metadata ALONE — no gen config, no
// codegen pipeline" (cli/src/commands/docs.ts). This generator reads `ctx.loadedRoot` and
// NOTHING else — no filesystem walk, no config read, no test-source scan. That sentence
// is what rules out reviving the retired `@verifiedBy` scan here, and it only keeps being
// true if nobody adds a second input.
//
// AN EMPTY LEDGER EMITS ZERO FILES, not an empty page. That is a contract with the
// surface wiring, not a cosmetic choice: `requirements` defaults to ON, and this is the
// only reason that is a no-op for every project without a ledger.
//
// BOTH FILES, UNCONDITIONALLY — deliberately not behind a `--format` flag. `meta docs`
// writes FILES, while `--format` on gen/migrate selects a STDOUT encoding; reusing the
// name would make it mean something materially different on this command. A drift gate
// also wants the machine-readable artifact committed regardless of who ran it or from
// what kind of terminal.

import {
  type EmittedFile,
  type Generator,
  type GeneratorFactory,
  oncePerRun,
} from "../generator.js";
import { renderRequirementsMarkdown } from "./requirements-markdown.js";
import { renderRequirementsToon } from "./requirements-toon.js";
import { requirementRows } from "./requirements-view.js";

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
