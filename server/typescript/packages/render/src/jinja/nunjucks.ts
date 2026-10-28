// The one place this package touches nunjucks (ADR-0061).
//
// nunjucks is the TypeScript port's Jinja engine. Its parser and node classes are
// public but untyped (`@types/nunjucks` types only the render API), so the small
// surface the render and verify paths read is declared here, once, instead of
// being cast at every call site.

import nunjucks from "nunjucks";
import { JINJA_EXTENSIONS } from "../engine.js";
import type { Provider } from "../provider.js";

/** A parsed nunjucks node. `fields` names the node's own child slots, in order. */
export interface NjNode {
  readonly typename: string;
  readonly fields: readonly string[];
  readonly lineno?: number;
  readonly [field: string]: unknown;
}

interface NunjucksInternals {
  parser: { parse(src: string): NjNode };
  lib: { escape(value: string): string };
}

const internals = nunjucks as unknown as NunjucksInternals;

/** Parse Jinja text into a nunjucks node tree. Throws on a syntax error. */
export function parseJinja(text: string): NjNode {
  return internals.parser.parse(text);
}

/** True for a parsed node (as opposed to a primitive slot value or null). */
export function isNode(value: unknown): value is NjNode {
  return typeof value === "object" && value !== null && typeof (value as NjNode).typename === "string";
}

/** The child nodes in a node's slots, in declaration order (a `children` list is flattened). */
export function childNodes(node: NjNode): NjNode[] {
  const out: NjNode[] = [];
  const push = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(push);
    else if (isNode(v)) out.push(v);
  };
  for (const f of node.fields) push(node[f]);
  // A block `{% set x %}…{% endset %}` keeps its body outside `fields`.
  if (node.typename === "Set") push(node["body"]);
  return out;
}

/**
 * The provider ref a Jinja template name addresses. Jinja code names files, so a
 * trailing `.jinja` / `.j2` / `.jinja2` is dropped: `{% include "parts/footer.jinja" %}`
 * and `{% include "parts/footer" %}` resolve the same `parts/footer` ref.
 */
export function refOfTemplateName(name: string): string {
  for (const ext of JINJA_EXTENSIONS) {
    if (name.toLowerCase().endsWith(ext)) return name.slice(0, -ext.length);
  }
  return name;
}

/**
 * A nunjucks environment whose loader is `provider` and whose escaping is
 * `escaper`. `autoescape` is on so every `{{ … }}` goes through the escape hook —
 * which `renderJinja` points at the format's escaper for the duration of one
 * synchronous render, exactly as `render()` does with `Mustache.escape`.
 */
function environment(provider: Provider): nunjucks.Environment {
  const loader = {
    getSource(name: string): { src: string; path: string; noCache: boolean } | null {
      const src = provider.resolve(refOfTemplateName(name));
      return src === undefined ? null : { src, path: name, noCache: true };
    },
  };
  return new nunjucks.Environment(loader as unknown as nunjucks.ILoader, {
    autoescape: true,
    throwOnUndefined: false,
    trimBlocks: false,
    lstripBlocks: false,
  });
}

/** Render Jinja `text` against `context`, escaping every `{{ … }}` with `escaper`. */
export function renderJinjaText(
  text: string,
  context: object,
  provider: Provider,
  escaper: (s: string) => string,
): string {
  const env = environment(provider);
  const prev = internals.lib.escape;
  internals.lib.escape = (v: unknown) => escaper(typeof v === "string" ? v : String(v));
  try {
    return env.renderString(text, context);
  } finally {
    internals.lib.escape = prev;
  }
}
