// Which template engine a body is written for (ADR-0061).
//
// Mustache is the default and the cross-port engine. Jinja is a per-port second
// engine (TypeScript and Python): a body is Jinja when its FILE says so — a
// `.jinja` / `.j2` / `.jinja2` extension beside the usual `.mustache` — or when
// the caller says so with an explicit `engine` option. The metadata never names
// an engine: `@textRef` stays a logical `group/source` reference, so the portable
// vocabulary carries nothing one port understands and another does not.

import type { Provider } from "./provider.js";

/** The engines `render` and `verify` accept. */
export const TEMPLATE_ENGINES = ["mustache", "jinja"] as const;
export type TemplateEngine = (typeof TEMPLATE_ENGINES)[number];

export const TEMPLATE_ENGINE_MUSTACHE: TemplateEngine = "mustache";
export const TEMPLATE_ENGINE_JINJA: TemplateEngine = "jinja";

/** The Mustache file extension — the default in every port. */
export const MUSTACHE_EXTENSION = ".mustache";

/** File extensions that mark a body as Jinja, in lookup order. */
export const JINJA_EXTENSIONS = [".jinja", ".j2", ".jinja2"] as const;

/** The engine a file extension (with its leading dot) selects. Anything else is Mustache. */
export function engineForExtension(extension: string): TemplateEngine {
  return (JINJA_EXTENSIONS as readonly string[]).includes(extension.toLowerCase())
    ? TEMPLATE_ENGINE_JINJA
    : TEMPLATE_ENGINE_MUSTACHE;
}

/**
 * The engine for `ref` resolved through `provider`: an explicit choice wins, then
 * what the provider knows about the ref (its file extension), then Mustache.
 */
export function templateEngineOf(
  provider: Provider | undefined,
  ref: string | undefined,
  explicit?: TemplateEngine,
): TemplateEngine {
  if (explicit !== undefined) return explicit;
  if (provider !== undefined && ref !== undefined) {
    const known = provider.engineOf?.(ref);
    if (known !== undefined) return known;
  }
  return TEMPLATE_ENGINE_MUSTACHE;
}
