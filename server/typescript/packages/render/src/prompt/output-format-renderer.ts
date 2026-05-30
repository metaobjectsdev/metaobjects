// FR-010 artifact 1 — output-format prompt renderer ("produce your answer like this").
//
// Renders an OutputFormatSpec into a prompt fragment that teaches an LLM how to
// shape its answer. Three comment-free styles (guide / inline / exampleOnly) ×
// two formats (json / xml). Guidance is carried in prose / inline placeholders /
// a filled skeleton — NEVER in comments (models ignore them).
//
// Cross-port INVARIANT: the rendered text is byte-identical to the Java/C#/Kotlin
// reference (com.metaobjects.render.prompt.OutputFormatRenderer). Do not change
// the verbatim prose, skeleton shapes, or numeric-vs-quoted decision.

import { ESCAPERS } from "../escapers.js";
import { FieldKind, Format } from "../recover/types.js";
import type { OutputFormatSpec } from "./output-format-spec.js";
import type { PromptField } from "./prompt-field.js";
import type { PromptOverrides } from "./prompt-overrides.js";
import { PromptStyle } from "./prompt-style.js";

const NUMERIC_KINDS: ReadonlySet<FieldKind> = new Set<FieldKind>([
  FieldKind.INT,
  FieldKind.LONG,
  FieldKind.DOUBLE,
  FieldKind.BOOLEAN,
]);

// The render engine OWNS format-keyed escaping; Format ("JSON"/"XML") maps to the
// lowercase ESCAPERS keys.
const escapeXml = (s: string): string => ESCAPERS.xml(s);
const escapeJson = (s: string): string => ESCAPERS.json(s);

/**
 * Render an {@link OutputFormatSpec} into an output-format prompt fragment. The
 * effective style is the override's style if present, otherwise the spec's.
 */
export function renderOutputFormat(spec: OutputFormatSpec, overrides: PromptOverrides): string {
  const effectiveStyle = overrides.style ?? spec.style;
  switch (effectiveStyle) {
    case PromptStyle.EXAMPLE_ONLY:
      return renderExampleOnly(spec, overrides);
    case PromptStyle.INLINE:
      return renderInline(spec, overrides);
    default:
      return renderGuide(spec, overrides);
  }
}

// ---- INLINE ----------------------------------------------------------------

function renderInline(spec: OutputFormatSpec, overrides: PromptOverrides): string {
  return spec.format === Format.XML
    ? renderXmlInline(spec, overrides)
    : renderJsonInline(spec, overrides);
}

function renderXmlInline(spec: OutputFormatSpec, overrides: PromptOverrides): string {
  const lines = spec.fields.map((field) => {
    const escaped = escapeXml(inlineContent(field, overrides));
    return `  <${field.name}>${escaped}</${field.name}>\n`;
  });
  return `<${spec.rootName}>\n${lines.join("")}</${spec.rootName}>`;
}

function renderJsonInline(spec: OutputFormatSpec, overrides: PromptOverrides): string {
  const lines = spec.fields.map(
    (field) => `  "${field.name}": "${escapeJson(inlineContent(field, overrides))}"`,
  );
  // Empty object is `{\n}` (Java/C# parity), not `{\n\n}` from join("") on no lines.
  return spec.fields.length === 0 ? "{\n}" : `{\n${lines.join(",\n")}\n}`;
}

function inlineContent(field: PromptField, overrides: PromptOverrides): string {
  if (field.kind === FieldKind.ENUM && field.enumValues != null && field.enumValues.length > 0) {
    return field.enumValues.join(" | ");
  }
  if (field.kind === FieldKind.BOOLEAN) {
    return "true | false";
  }
  const instruction = resolveInstruction(field, overrides);
  return instruction != null ? `{${instruction}}` : `{${field.name}}`;
}

/** Effective instruction: override first, then the field default, else null. */
function resolveInstruction(field: PromptField, overrides: PromptOverrides): string | null {
  const ov = overrides.instructions?.[field.name];
  if (ov != null) return ov;
  return field.instruction;
}

// ---- GUIDE -----------------------------------------------------------------

function renderGuide(spec: OutputFormatSpec, overrides: PromptOverrides): string {
  let sb = "Fill in each field as described below:\n";
  for (const field of spec.fields) {
    const req = field.required ? "required" : "optional";
    sb += `- ${field.name} (${req})`;
    const instruction = resolveInstruction(field, overrides);
    if (instruction != null) {
      sb += `: ${instruction}`;
    }
    sb += "\n";
    if (field.kind === FieldKind.ENUM && field.enumValues != null && field.enumValues.length > 0) {
      sb += `    one of ${field.enumValues.join(", ")}\n`;
      const enumDoc = field.enumDoc;
      if (enumDoc != null) {
        for (const val of field.enumValues) {
          const doc = enumDoc[val];
          if (doc != null) {
            sb += `      ${val} = ${doc}\n`;
          }
        }
      }
    }
    const eg = exampleValueIfDeclared(field, overrides);
    if (eg != null) {
      sb += `    e.g. ${eg}\n`;
    }
  }
  sb += "\nRespond exactly like this:\n";
  sb += renderExampleOnly(spec, overrides);
  return sb;
}

// ---- EXAMPLE-ONLY (also the skeleton appended by GUIDE) ---------------------

function renderExampleOnly(spec: OutputFormatSpec, overrides: PromptOverrides): string {
  return spec.format === Format.XML
    ? renderXmlSkeleton(spec, overrides)
    : renderJsonSkeleton(spec, overrides);
}

function renderXmlSkeleton(spec: OutputFormatSpec, overrides: PromptOverrides): string {
  const lines = spec.fields.map((field) => {
    const escaped = escapeXml(exampleValue(field, overrides));
    return `  <${field.name}>${escaped}</${field.name}>\n`;
  });
  return `<${spec.rootName}>\n${lines.join("")}</${spec.rootName}>`;
}

function renderJsonSkeleton(spec: OutputFormatSpec, overrides: PromptOverrides): string {
  // NOTE: FieldKind.OBJECT / nested fields are not expanded here — they render as
  // a "{fieldName}" placeholder. Nested-object expansion is a bounded deferral
  // (mirrors Java/C#).
  const lines = spec.fields.map((field) => {
    const value = exampleValue(field, overrides);
    const rendered = isNumericOrBoolean(field.kind, value) ? value : `"${escapeJson(value)}"`;
    return `  "${field.name}": ${rendered}`;
  });
  // Empty object is `{\n}` (Java/C# parity), not `{\n\n}` from join("") on no lines.
  return spec.fields.length === 0 ? "{\n}" : `{\n${lines.join(",\n")}\n}`;
}

function exampleValueIfDeclared(field: PromptField, overrides: PromptOverrides): string | null {
  const ov = overrides.examples?.[field.name];
  if (ov != null) return ov;
  if (field.example != null) return field.example;
  return null;
}

function exampleValue(field: PromptField, overrides: PromptOverrides): string {
  const ov = overrides.examples?.[field.name];
  if (ov != null) return ov;
  if (field.example != null) return field.example;
  if (field.kind === FieldKind.ENUM && field.enumValues != null && field.enumValues.length > 0) {
    return field.enumValues[0]!;
  }
  return `{${field.name}}`;
}

function isNumericOrBoolean(kind: FieldKind, value: string): boolean {
  if (!NUMERIC_KINDS.has(kind)) return false;
  if (value === "true" || value === "false") return true;
  // Finite-only: NaN/Infinity fall through to a quoted string so the emitted JSON
  // stays valid. Number("") is 0, so guard the empty/blank case explicitly. Reject
  // JS-only radix literals (0x../0b../0o..) that Number() accepts but Java/C# don't —
  // same guard as the recover engine's parseFiniteNumber (keeps the JSON valid + parity).
  const t = value.trim();
  if (t === "" || /^[+-]?0[xXbBoO]/.test(t)) return false;
  return Number.isFinite(Number(t));
}
