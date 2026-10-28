// Render a Jinja body (ADR-0061): the nunjucks engine, with the same provider,
// the same format-driven escapers and the same partial rules as the Mustache path.
//
// Before rendering, the static template graph (`{% include %}` / `{% import %}` /
// `{% extends %}` with a literal name) is resolved once, so a cycle or a missing
// template fails with the same messages the Mustache path uses ("partial cycle:",
// "unresolved partial:") rather than as a stack overflow inside the engine.

import type { Provider } from "../provider.js";
import { MAX_DEPTH } from "../verify-shared.js";
import { TEMPLATE_ENGINE_JINJA, partialEngineMessage, partialEngineMismatch } from "../engine.js";
import { childNodes, parseJinja, refOfTemplateName, renderJinjaText, type NjNode } from "./nunjucks.js";

const TEMPLATE_REF_NODES: ReadonlySet<string> = new Set(["Include", "Import", "FromImport", "Extends"]);

function literalTemplateRefs(node: NjNode, out: { ref: string; optional: boolean }[]): void {
  if (TEMPLATE_REF_NODES.has(node.typename)) {
    const t = node["template"] as NjNode;
    if (t.typename === "Literal" && typeof t["value"] === "string") {
      out.push({ ref: refOfTemplateName(t["value"]), optional: node["ignoreMissing"] === true });
    }
  }
  for (const child of childNodes(node)) literalTemplateRefs(child, out);
}

function checkTemplateGraph(text: string, provider: Provider, path: readonly string[]): void {
  const refs: { ref: string; optional: boolean }[] = [];
  literalTemplateRefs(parseJinja(text), refs);
  for (const { ref, optional } of refs) {
    if (path.includes(ref)) throw new Error(`partial cycle: ${[...path, ref].join(" -> ")}`);
    if (path.length >= MAX_DEPTH) throw new Error(`partial depth exceeded ${MAX_DEPTH}: ${ref}`);
    const body = provider.resolve(ref);
    if (body === undefined) {
      if (optional) continue;
      throw new Error(`unresolved partial: ${ref}`);
    }
    if (partialEngineMismatch(provider, ref, TEMPLATE_ENGINE_JINJA)) {
      throw new Error(partialEngineMessage(ref, TEMPLATE_ENGINE_JINJA));
    }
    checkTemplateGraph(body, provider, [...path, ref]);
  }
}

/** Render Jinja `body` (whose own ref, when it has one, is `ref`) against `payload`. */
export function renderJinja(
  body: string,
  ref: string | undefined,
  payload: unknown,
  provider: Provider,
  escaper: (s: string) => string,
): string {
  checkTemplateGraph(body, provider, ref !== undefined ? [ref] : []);
  const context = typeof payload === "object" && payload !== null ? payload : {};
  return renderJinjaText(body, context, provider, escaper);
}
