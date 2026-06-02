import { oncePerRun, type Generator, type GeneratorFactory } from "../generator.js";
import { renderMermaidModel } from "../templates/mermaid-er.js";

export interface MermaidErOptions {
  /** Output path relative to the target's outDir. Defaults to "docs/model.md". */
  outFile?: string;
  /** Named output target. */
  target?: string;
}

/**
 * Emit a single Markdown file containing a Mermaid `erDiagram` plus per-entity
 * prose sections. The renderer walks the loaded root for all entities; the
 * default outFile is "docs/model.md".
 *
 * TIER NOTE (ADR-0020): the CANONICAL home of the neutral ER diagram is now the
 * neutral docs engine — the OVERVIEW/index page (`README.md`) emitted by
 * `docsFile()` / `meta docs` embeds the SAME `renderMermaidErBlock()` this
 * generator's `renderMermaidModel()` reuses. This standalone Tier-1 generator is
 * retained ONLY as a thin back-compat wrapper for adopters that already have
 * `mermaidErDiagram` in their `meta gen` config; it adds NO ER logic of its own
 * (no duplication) — it delegates to the shared `renderMermaidModel()` builder.
 */
export const mermaidErDiagram = function mermaidErDiagram(
  opts?: MermaidErOptions,
): Generator {
  const outFile = opts?.outFile ?? "docs/model.md";
  const generator: Generator = {
    name: "mermaid-er-diagram",
    generate: oncePerRun((_entities, ctx) => ({
      path: outFile,
      content: renderMermaidModel(ctx.loadedRoot),
    })),
  };
  if (opts?.target) generator.target = opts.target;
  return generator;
} as GeneratorFactory<MermaidErOptions>;
