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
