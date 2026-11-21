// server/typescript/packages/codegen-ts/src/generators/requirements-file.ts
//
// The `requirements` docs surface generator — emits the ledger as documentation.
//
// Design: docs/superpowers/specs/2026-08-21-requirements-doc-surface-design.md
//
// METADATA ALONE. This generator reads `ctx.loadedRoot` and NOTHING else — no filesystem
// walk, no config read, no test-source scan. That sentence is what rules out reviving the
// retired `@verifiedBy` scan here, and it only keeps being true if nobody adds a second
// input. The one file it may read is a page TEMPLATE (the project's `templates/requirements/`
// override), which shapes the layout and never adds a fact.
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
import { docsTemplateRoot, projectProvider } from "../render-engine/framework-provider.js";

/** The human-facing index. */
const MARKDOWN_FILENAME = "requirements.md";
/** The machine-facing artifact — see requirements-toon.ts for why TOON. */
const TOON_FILENAME = "requirements.toon";

export interface RequirementsFileOpts {
  /** Output directory prefix relative to the target's outDir. Default: "" (root). */
  outDir?: string;
  /** Named output target. Default `"docs"`, which `targets` must declare. */
  target?: string;
  /** Directory whose `templates/requirements/requirements.{md,toon}.mustache` override the
   *  shipped pages, relative to the project. Default: the project's own `templates/`. */
  templates?: string;
}

export const requirementsFile = function requirementsFile(
  opts?: RequirementsFileOpts,
): Generator {
  const dirPrefix = opts?.outDir ? `${opts.outDir.replace(/\/$/, "")}/` : "";

  const generator: Generator = {
    name: "requirements-file",
    target: opts?.target ?? DOCS_TARGET_NAME,
    generate: oncePerRun((_entities, ctx) => {
      const rows = requirementRows(ctx.loadedRoot, ctx.inLedger);
      // The one early return that matters. Both renderers also return "" for an empty
      // ledger, so this is belt-and-braces — but the guarantee callers depend on is
      // "zero FILES", which only this line can provide.
      if (rows.length === 0) return [];

      const provider = projectProvider(docsTemplateRoot(ctx, opts?.templates));
      const files: EmittedFile[] = [
        { path: `${dirPrefix}${MARKDOWN_FILENAME}`, content: renderRequirementsMarkdown(rows, { provider }) },
        { path: `${dirPrefix}${TOON_FILENAME}`, content: renderRequirementsToon(rows, provider) },
      ];
      return files;
    }),
  };
  return generator;
} as GeneratorFactory<RequirementsFileOpts>;
