// What `meta verify --templates` checks about a prompt's REPLY (`@responseRef`).
//
// The loader already refuses a `@responseRef` that names nothing (`ERR_INVALID_TEMPLATE`),
// so this gate checks what loading cannot:
//
//   - the reply type has a field tree a parser can read (`ERR_RESPONSE_UNRESOLVED`, an
//     error: a reply with no fields parses into nothing);
//   - for an `@responseFormat: xml` prompt, every `@requiredTags` tag — which the body is
//     already held to (`ERR_OUTPUT_TAG_MISSING`) — names the reply type or one of its
//     fields (`ERR_RESPONSE_TAG_UNDECLARED`, a warning). The body teaches the model those
//     tags and the extractor reads the reply type's fields; this is the link between them,
//     so a renamed reply field stops matching the tag the prompt still asks for.
//
// Pinned cross-port by fixtures/response-verify-conformance/.

import {
  type MetaData,
  RESPONSE_FORMAT_XML,
  TEMPLATE_ATTR_REQUIRED_TAGS,
  TEMPLATE_ATTR_RESPONSE_FORMAT,
  TEMPLATE_ATTR_RESPONSE_REF,
  TEMPLATE_SUBTYPE_PROMPT,
  TYPE_TEMPLATE,
  refTarget,
} from "@metaobjectsdev/metadata";
import type { PayloadField } from "@metaobjectsdev/render";
import { derivePayloadFieldTree } from "./payload-field-tree.js";

/** A responding prompt's `@responseRef` names no loaded value shape with fields. */
export const ERR_RESPONSE_UNRESOLVED = "ERR_RESPONSE_UNRESOLVED";
/** An xml prompt's `@requiredTags` tag names neither the reply type nor a reply field (warning). */
export const ERR_RESPONSE_TAG_UNDECLARED = "ERR_RESPONSE_TAG_UNDECLARED";

export interface ResponseFinding {
  readonly code: string;
  /** The `@responseRef` value, or the offending tag. */
  readonly path: string;
  readonly severity: "error" | "warning";
}

function fieldNames(tree: readonly PayloadField[], out: Set<string>): Set<string> {
  for (const f of tree) {
    out.add(f.name);
    if (f.fields !== undefined) fieldNames(f.fields, out);
  }
  return out;
}

function shortName(name: string): string {
  const i = name.lastIndexOf("::");
  return i === -1 ? name : name.slice(i + 2);
}

/**
 * The reply findings for one template. Empty for anything that is not a `template.prompt`
 * carrying `@responseRef` — a prompt that does not elicit a typed reply has nothing here.
 */
export function responseFindings(tmpl: MetaData): ResponseFinding[] {
  if (tmpl.type !== TYPE_TEMPLATE || tmpl.subType !== TEMPLATE_SUBTYPE_PROMPT) return [];
  // ADR-0039: effective attrs — a prompt may inherit @responseRef / @responseFormat / @requiredTags.
  const responseRef = tmpl.attr(TEMPLATE_ATTR_RESPONSE_REF);
  if (typeof responseRef !== "string") return [];

  const reply = refTarget(tmpl, TEMPLATE_ATTR_RESPONSE_REF);
  const tree = derivePayloadFieldTree(reply);
  if (reply === undefined || tree.length === 0) {
    return [{ code: ERR_RESPONSE_UNRESOLVED, path: responseRef, severity: "error" }];
  }

  const format = tmpl.attr(TEMPLATE_ATTR_RESPONSE_FORMAT);
  if (typeof format !== "string" || format.toLowerCase() !== RESPONSE_FORMAT_XML) return [];
  const tags = tmpl.attr(TEMPLATE_ATTR_REQUIRED_TAGS);
  if (!Array.isArray(tags)) return [];
  const known = fieldNames(tree, new Set([shortName(reply.name)]));
  return tags
    .filter((t): t is string => typeof t === "string" && !known.has(t))
    .map((t) => ({ code: ERR_RESPONSE_TAG_UNDECLARED, path: t, severity: "warning" as const }));
}
