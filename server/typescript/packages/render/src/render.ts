import Mustache from "mustache";
import type { Provider } from "./provider.js";
import { ESCAPERS, type RenderFormat } from "./escapers.js";
import { verify, ERR_REQUIRED_SLOT_UNUSED, type PayloadField } from "./verify.js";

const MAX_DEPTH = 32;
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
}

/** Deterministic, logic-less render: (template + payload + provider) → string. */
export function render(o: RenderOptions): string {
  const body = o.template ?? (o.ref !== undefined ? o.provider.resolve(o.ref) : undefined);
  if (body === undefined) throw new Error(`unresolved ref: ${o.ref ?? "(none)"}`);

  if (o.verify !== undefined) {
    const drift = verify(body, o.verify, { provider: o.provider }).filter(
      (e) => e.code !== ERR_REQUIRED_SLOT_UNUSED,
    );
    if (drift.length > 0) {
      throw new Error(
        `render verify failed: ${drift.map((e) => `${e.code} (${e.path})`).join(", ")}`,
      );
    }
  }

  const expanded = expand(body, o.provider, o.ref !== undefined ? [o.ref] : []);
  const escaper = ESCAPERS[o.format ?? "text"];

  const prev = Mustache.escape;
  Mustache.escape = (v: unknown) => escaper(typeof v === "string" ? v : String(v));
  try {
    return Mustache.render(expanded, o.payload, {});
  } finally {
    Mustache.escape = prev;
  }
}
