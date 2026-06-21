// server/typescript/packages/codegen-ts/src/templates/render-helper.ts
//
// Per-template.output render helper: emits a typed `render<Name>(payload, provider)`
// that wraps the EXISTING render() engine, AND enforces the mustache↔payload-VO
// drift check (the EXISTING verify() engine) at BUILD time.
//
// Two shapes, keyed off @kind:
//   • document (default) → renders @textRef in @format → one string.
//   • email              → renders @subjectRef + @htmlBodyRef (+ optional
//                           @textBodyRef) → a structured EmailDocument.
//
// The headline is the BUILD-TIME drift gate: BEFORE emitting, every referenced
// mustache is resolved via the codegen-time provider and verify()'d against the
// payload field tree. If a referenced text is unresolvable OR carries any
// NON-warning verify error (e.g. `{{field}}` not on the payload VO), this THROWS
// and FAILS codegen — naming the template, the ref, the error code, and the
// offending field. This is what makes the build fail when a mustache references
// a field the payload VO doesn't declare.
//
// Reuse, not reimplementation:
//   • render()  — the runtime helper delegates to it (emitted call).
//   • verify()  — run here at build time for the drift gate.
//   • derivePayloadFieldTree (replicated minimally below — codegen-ts must NOT
//     depend on the cli package; the walk is the same as cli's payload-field-tree).
//   • PayloadField — the verify() field-tree shape; serialized into the emitted
//     `verify:` literal so render()'s runtime drift check runs too.

import {
  type MetaData,
  TYPE_OBJECT,
  TYPE_FIELD,
  TYPE_TEMPLATE,
  FIELD_SUBTYPE_OBJECT,
  FIELD_ATTR_OBJECT_REF,
  TEMPLATE_SUBTYPE_OUTPUT,
  TEMPLATE_ATTR_PAYLOAD_REF,
  TEMPLATE_ATTR_TEXT_REF,
  TEMPLATE_ATTR_FORMAT,
  TEMPLATE_ATTR_MAX_CHARS,
  TEMPLATE_ATTR_KIND,
  TEMPLATE_KIND_EMAIL,
  TEMPLATE_KIND_DEFAULT,
  TEMPLATE_ATTR_SUBJECT_REF,
  TEMPLATE_ATTR_HTML_BODY_REF,
  TEMPLATE_ATTR_TEXT_BODY_REF,
  refMatchesObject,
} from "@metaobjectsdev/metadata";
import {
  verify,
  ERR_REQUIRED_SLOT_UNUSED,
  type Provider,
  type PayloadField,
  type VerifyError,
} from "@metaobjectsdev/render";

function findObject(root: MetaData, name: string): MetaData | undefined {
  return root.ownChildren().find((c) => c.type === TYPE_OBJECT && refMatchesObject(c, name));
}

function findTemplate(root: MetaData, name: string): MetaData | undefined {
  return root.ownChildren().find((c) => c.type === TYPE_TEMPLATE && c.name === name);
}

/**
 * Walk an `object.value` view-object into a render `PayloadField[]`. Object-ref
 * fields recurse into their referenced view-object; a `seen` set guards a
 * (pathological) reference cycle. Replicates cli's `derivePayloadFieldTree` —
 * codegen-ts must not depend on the cli package (wrong layer / would cycle), so
 * the same small walk lives here against the metadata constants codegen-ts
 * already imports.
 */
function derivePayloadFieldTree(
  root: MetaData,
  voName: string,
  seen: ReadonlySet<string> = new Set(),
): PayloadField[] {
  if (seen.has(voName)) return [];
  const vo = findObject(root, voName);
  if (!vo) return [];
  const nextSeen = new Set(seen).add(voName);
  const fields: PayloadField[] = [];
  for (const f of vo.children().filter((c) => c.type === TYPE_FIELD)) {
    if (f.subType === FIELD_SUBTYPE_OBJECT) {
      const ref = f.attr(FIELD_ATTR_OBJECT_REF);
      if (typeof ref === "string") {
        fields.push({ name: f.name, fields: derivePayloadFieldTree(root, ref, nextSeen) });
        continue;
      }
    }
    fields.push({ name: f.name });
  }
  return fields;
}

/** Serialize a PayloadField[] as a stable, deterministic TS array literal so the
 *  emitted render() call runs the same runtime drift check the build gate ran. */
function fieldTreeLiteral(fields: PayloadField[]): string {
  // JSON.stringify is deterministic for this shape (no functions/cycles by
  // construction) and produces valid TS object/array literal syntax.
  return JSON.stringify(fields);
}

/** Run the build-time drift gate for one referenced mustache. Throws (fails
 *  codegen) when the ref is unresolvable OR verify() reports a non-warning error.
 *  Warnings (ERR_REQUIRED_SLOT_UNUSED) are tolerated. */
function gateRef(
  templateName: string,
  ref: string,
  provider: Provider,
  fields: PayloadField[],
): void {
  const text = provider.resolve(ref);
  if (text === undefined) {
    throw new Error(
      `render-helper drift: template "${templateName}" ref "${ref}" — unresolved (provider returned no text)`,
    );
  }
  const errors: VerifyError[] = verify(text, fields, { provider }).filter(
    (e) => e.code !== ERR_REQUIRED_SLOT_UNUSED,
  );
  if (errors.length > 0) {
    const e = errors[0]!;
    throw new Error(
      `render-helper drift: template "${templateName}" ref "${ref}" — ${e.code}: {{${e.path}}} not on payload VO`,
    );
  }
}

/**
 * Render the per-template render-helper source for one `template.output`, AND
 * run the build-time drift gate first. Throws if: the template isn't found /
 * isn't a template.output; @payloadRef is missing or doesn't resolve to an
 * object.value; a required ref for the kind is missing; or ANY referenced
 * mustache drifts from the payload VO (the headline build gate).
 *
 * @param provider the codegen-time provider (e.g. projectProvider(projectRoot))
 *                 used to resolve + verify each referenced mustache at build time.
 */
export function renderRenderHelper(
  root: MetaData,
  templateName: string,
  provider: Provider,
): string {
  const tmpl = findTemplate(root, templateName);
  if (!tmpl) {
    throw new Error(`template "${templateName}" not found in metadata root`);
  }
  if (tmpl.subType !== TEMPLATE_SUBTYPE_OUTPUT) {
    throw new Error(
      `template "${templateName}" is not a template.output (got subtype "${tmpl.subType}")`,
    );
  }
  const payloadRef = tmpl.ownAttr(TEMPLATE_ATTR_PAYLOAD_REF);
  if (typeof payloadRef !== "string") {
    throw new Error(`template "${templateName}" missing @payloadRef`);
  }
  const vo = findObject(root, payloadRef);
  if (!vo) {
    throw new Error(
      `template "${templateName}" @payloadRef "${payloadRef}" not found in metadata root`,
    );
  }

  const fields = derivePayloadFieldTree(root, payloadRef);
  const ft = fieldTreeLiteral(fields);
  const fnName = `render${templateName}`;

  const kind = ((tmpl.ownAttr(TEMPLATE_ATTR_KIND) as string | undefined) ?? TEMPLATE_KIND_DEFAULT)
    .toLowerCase();

  if (kind === TEMPLATE_KIND_EMAIL) {
    const subjectRef = tmpl.ownAttr(TEMPLATE_ATTR_SUBJECT_REF);
    const htmlBodyRef = tmpl.ownAttr(TEMPLATE_ATTR_HTML_BODY_REF);
    const textBodyRef = tmpl.ownAttr(TEMPLATE_ATTR_TEXT_BODY_REF);
    if (typeof subjectRef !== "string") {
      throw new Error(`template "${templateName}" (email) missing @subjectRef`);
    }
    if (typeof htmlBodyRef !== "string") {
      throw new Error(`template "${templateName}" (email) missing @htmlBodyRef`);
    }

    // BUILD-TIME drift gate — every email part-ref is resolved + verified.
    gateRef(templateName, subjectRef, provider, fields);
    gateRef(templateName, htmlBodyRef, provider, fields);
    if (typeof textBodyRef === "string") {
      gateRef(templateName, textBodyRef, provider, fields);
    }

    const textBodyLine =
      typeof textBodyRef === "string"
        ? `\n    textBody: render({ ref: ${JSON.stringify(textBodyRef)}, payload, format: "text", provider, verify: ${ft} }),`
        : "";

    return `import { render } from "@metaobjectsdev/render";
import type { Provider, EmailDocument } from "@metaobjectsdev/render";
import type { ${payloadRef} } from "./${payloadRef}.js";

/**
 * Render the ${templateName} email (subject + html body${typeof textBodyRef === "string" ? " + text body" : ""}) from a
 * typed ${payloadRef} payload. Wraps the render() engine; the payload field tree is
 * baked in so render()'s runtime drift check matches the build-time gate.
 */
export function ${fnName}(payload: ${payloadRef}, provider: Provider): EmailDocument {
  return {
    subject: render({ ref: ${JSON.stringify(subjectRef)}, payload, format: "text", provider, verify: ${ft} }),
    htmlBody: render({ ref: ${JSON.stringify(htmlBodyRef)}, payload, format: "html", provider, verify: ${ft} }),${textBodyLine}
  };
}
`;
  }

  // --- document kind ---
  const textRef = tmpl.ownAttr(TEMPLATE_ATTR_TEXT_REF);
  if (typeof textRef !== "string") {
    throw new Error(`template "${templateName}" (document) missing @textRef`);
  }
  const format = ((tmpl.ownAttr(TEMPLATE_ATTR_FORMAT) as string | undefined) ?? "text").toLowerCase();
  const maxCharsAttr = tmpl.ownAttr(TEMPLATE_ATTR_MAX_CHARS);
  const maxChars =
    typeof maxCharsAttr === "number"
      ? maxCharsAttr
      : typeof maxCharsAttr === "string" && maxCharsAttr.trim() !== ""
        ? Number(maxCharsAttr)
        : undefined;

  // BUILD-TIME drift gate.
  gateRef(templateName, textRef, provider, fields);

  const maxCharsArg =
    maxChars !== undefined && Number.isFinite(maxChars) ? `, maxChars: ${maxChars}` : "";

  return `import { render } from "@metaobjectsdev/render";
import type { Provider } from "@metaobjectsdev/render";
import type { ${payloadRef} } from "./${payloadRef}.js";

/**
 * Render the ${templateName} document from a typed ${payloadRef} payload. Wraps the
 * render() engine; the payload field tree is baked in so render()'s runtime drift
 * check matches the build-time gate enforced when this file was generated.
 */
export function ${fnName}(payload: ${payloadRef}, provider: Provider): string {
  return render({ ref: ${JSON.stringify(textRef)}, payload, format: ${JSON.stringify(format)}, provider, verify: ${ft}${maxCharsArg} });
}
`;
}
