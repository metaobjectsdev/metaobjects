// server/typescript/packages/codegen-ts/src/generators/requirements-file.ts
//
// The `requirements` docs surface generator — emits the ledger as documentation.
//
// Design: docs/superpowers/specs/2026-08-21-requirements-doc-surface-design.md
//
// METADATA ALONE. This generator reads `ctx.loadedRoot` and NOTHING else — no filesystem
// walk, no config read, no test-source scan. That sentence is what rules out reviving the
// retired `@verifiedBy` scan here, and it only keeps being true if nobody adds a second
// input.
//
// AN EMPTY LEDGER EMITS ZERO FILES, not an empty page, so a project without a ledger that
// lists this generator gets nothing rather than a page saying there is nothing.
//
// BOTH FILES, UNCONDITIONALLY — deliberately not behind an option: a drift gate wants the
// machine-readable artifact committed regardless of who ran it or from what kind of
// terminal.

import {
  type EmittedFile,
  type Generator,
  type GeneratorFactory,
  oncePerRun,
} from "../generator.js";
import { renderRequirementsMarkdown } from "./requirements-markdown.js";
import { renderRequirementsToon } from "./requirements-toon.js";
import { requirementRows } from "./requirements-view.js";
import { DOCS_TARGET_NAME } from "../docs-run.js";

/** The human-facing index. */
const MARKDOWN_FILENAME = "requirements.md";
/** The machine-facing artifact — see requirements-toon.ts for why TOON. */
const TOON_FILENAME = "requirements.toon";

export interface RequirementsFileOpts {
  /** Output directory prefix relative to the target's outDir. Default: "" (root). */
  outDir?: string;
  /** Named output target. Default `"docs"`, which `targets` must declare. */
  target?: string;
}

export const requirementsFile = function requirementsFile(
  opts?: RequirementsFileOpts,
): Generator {
  const dirPrefix = opts?.outDir ? `${opts.outDir.replace(/\/$/, "")}/` : "";

  const generator: Generator = {
    name: "requirements-file",
    target: opts?.target ?? DOCS_TARGET_NAME,
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
  return generator;
} as GeneratorFactory<RequirementsFileOpts>;
