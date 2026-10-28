import Mustache from "mustache";
import type { Provider } from "./provider.js";
import { ESCAPERS, type RenderFormat } from "./escapers.js";
import { verify, ERR_REQUIRED_SLOT_UNUSED, type PayloadField } from "./verify.js";
import { withDerivedAccessors } from "./payload-accessors.js";
import { TEMPLATE_ENGINE_JINJA, templateEngineOf, type TemplateEngine } from "./engine.js";
import { renderJinja } from "./jinja/render.js";
import { MAX_DEPTH } from "./verify-shared.js";

const PARTIAL = /\{\{>\s*([^}\s]+)\s*\}\}/g;

// Resolve `{{> group/source }}` partials by inlining their text, recursively,
// BEFORE Mustache parses — giving us deterministic whitespace and true,
// path-based cycle/depth detection (no reliance on a per-lib partial loader).
// Inlined text still renders in the surrounding context (e.g. once per loop
// item), exactly like a native partial, because Mustache renders the result.
function expand(text: string, provider: Provider, path: readonly string[]): string {
  return text.replace(PARTIAL, (_match, ref: string) => {
    if (path.includes(ref)) throw new Error(`partial cycle: ${[...path, ref].join(" -> ")}`);
    if (path.length >= MAX_DEPTH) throw new Error(`partial depth exceeded ${MAX_DEPTH}: ${ref}`);
    const t = provider.resolve(ref);
    if (t === undefined) throw new Error(`unresolved partial: ${ref}`);
    return expand(t, provider, [...path, ref]);
  });
}

export interface RenderOptions {
  /** Inline template text. Mutually exclusive with `ref`. */
  template?: string;
  /** A `group/source` reference resolved via `provider`. */
  ref?: string;
  /** The render payload (a plain object/array graph; pre-format primitives). */
  payload: unknown;
  provider: Provider;
  /** Output format; drives escaping. Defaults to "text" (raw). */
  format?: RenderFormat;
  /**
   * Fail-closed guard for dynamic/generated text: when given a payload field
   * tree, the RESOLVED template is `verify`'d before rendering and a drifted
   * variant throws — instead of silently rendering nothing.
   */
  verify?: PayloadField[];
  /**
   * Output budget in characters. Rendered length is data-dependent (only knowable
   * after rendering), so this is a render-time guard: a result longer than
   * `maxChars` throws. (Token budgets are out of scope — model-specific tokenizer.)
   */
  maxChars?: number;
  /**
   * The engine the body is written for (ADR-0061). Default: what the provider
   * reports for `ref` (a `.jinja` / `.j2` file is Jinja), else Mustache. Inline
   * `template` text has no file, so it is Mustache unless this says otherwise.
   */
  engine?: TemplateEngine;
}

/** Deterministic render: (template + payload + provider) → string. Mustache unless the body is Jinja. */
export function render(o: RenderOptions): string {
  const body = o.template ?? (o.ref !== undefined ? o.provider.resolve(o.ref) : undefined);
  if (body === undefined) throw new Error(`unresolved ref: ${o.ref ?? "(none)"}`);
  const engine = templateEngineOf(o.provider, o.template === undefined ? o.ref : undefined, o.engine);

  if (o.verify !== undefined) {
    const drift = verify(body, o.verify, { provider: o.provider, engine }).filter(
      (e) => e.code !== ERR_REQUIRED_SLOT_UNUSED,
    );
    if (drift.length > 0) {
      throw new Error(
        `render verify failed: ${drift.map((e) => `${e.code} (${e.path})`).join(", ")}`,
      );
    }
  }

  const escaper = ESCAPERS[o.format ?? "text"];
  const result =
    engine === TEMPLATE_ENGINE_JINJA
      ? renderJinja(body, o.template === undefined ? o.ref : undefined, o.payload, o.provider, escaper)
      : renderMustache(body, o, escaper);

  if (o.maxChars !== undefined && result.length > o.maxChars) {
    throw new Error(`render exceeded maxChars budget: ${result.length} > ${o.maxChars}`);
  }
  return result;
}

function renderMustache(body: string, o: RenderOptions, escaper: (s: string) => string): string {
  const expanded = expand(body, o.provider, o.ref !== undefined ? [o.ref] : []);

  const prev = Mustache.escape;
  Mustache.escape = (v: unknown) => escaper(typeof v === "string" ? v : String(v));
  let result: string;
  try {
    // Derived `has<Field>` accessors are part of the payload contract, not of the
    // caller's object — see payload-accessors.ts. Injected here so a `{{#hasFoo}}`
    // section resolves the same way it does against a generated JVM payload record.
    result = Mustache.render(expanded, withDerivedAccessors(o.payload), {});
  } finally {
    Mustache.escape = prev;
  }
  return result;
}
