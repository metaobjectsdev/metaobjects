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
import { FieldKind, Format } from "../extract/types.js";
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

const INDENT = "  ";
const MAX_NEST_DEPTH = 8;

type SkelMode = "example" | "inline";

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
    ? renderXmlSkeleton(spec, overrides, "inline")
    : renderJsonSkeleton(spec, overrides, "inline");
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
  sb += guideFields(spec, overrides, "", new Set<OutputFormatSpec>([spec]), 0);
  sb += "\nRespond exactly like this:\n";
  sb += renderExampleOnly(spec, overrides);
  return sb;
}

function guideFields(
  spec: OutputFormatSpec, overrides: PromptOverrides, prefix: string,
  path: Set<OutputFormatSpec>, depth: number,
): string {
  let sb = "";
  for (const field of spec.fields) {
    const displayName = prefix + field.name;
    sb += guideEntry(field, overrides, displayName);
    if (canExpand(field, path, depth)) {
      const nested = field.nested!;
      const childPrefix = field.array ? `${displayName}[].` : `${displayName}.`;
      path.add(nested);
      sb += guideFields(nested, overrides, childPrefix, path, depth + 1);
      path.delete(nested);
    }
  }
  return sb;
}

function guideEntry(field: PromptField, overrides: PromptOverrides, displayName: string): string {
  const req = field.required ? "required" : "optional";
  let sb = `- ${displayName} (${req})`;
  const instruction = resolveInstruction(field, overrides);
  if (instruction != null) sb += `: ${instruction}`;
  sb += "\n";
  if (field.kind === FieldKind.ENUM && field.enumValues != null && field.enumValues.length > 0) {
    sb += `    one of ${field.enumValues.join(", ")}\n`;
    const enumDoc = field.enumDoc;
    if (enumDoc != null) {
      for (const val of field.enumValues) {
        const doc = enumDoc[val];
        if (doc != null) sb += `      ${val} = ${doc}\n`;
      }
    }
  }
  const eg = exampleValueIfDeclared(field, overrides);
  if (eg != null) sb += `    e.g. ${eg}\n`;
  return sb;
}

// ---- EXAMPLE-ONLY (also the skeleton appended by GUIDE) ---------------------

function renderExampleOnly(spec: OutputFormatSpec, overrides: PromptOverrides): string {
  return spec.format === Format.XML
    ? renderXmlSkeleton(spec, overrides, "example")
    : renderJsonSkeleton(spec, overrides, "example");
}

// ---- JSON skeleton (recursive) ---------------------------------------------

function renderJsonSkeleton(spec: OutputFormatSpec, overrides: PromptOverrides, mode: SkelMode): string {
  return jsonObject(spec, overrides, "", mode, new Set<OutputFormatSpec>([spec]), 0);
}

function jsonObject(
  spec: OutputFormatSpec, overrides: PromptOverrides, braceIndent: string,
  mode: SkelMode, path: Set<OutputFormatSpec>, depth: number,
): string {
  if (spec.fields.length === 0) return `{\n${braceIndent}}`;
  const fieldIndent = braceIndent + INDENT;
  const lines = spec.fields.map(
    (field) => `${fieldIndent}"${field.name}": ${jsonValue(field, overrides, fieldIndent, mode, path, depth)}`,
  );
  return `{\n${lines.join(",\n")}\n${braceIndent}}`;
}

function jsonValue(
  field: PromptField, overrides: PromptOverrides, indent: string,
  mode: SkelMode, path: Set<OutputFormatSpec>, depth: number,
): string {
  if (field.array) return jsonArray(field, overrides, indent, mode, path, depth);
  if (field.kind === FieldKind.OBJECT) return jsonObjectField(field, overrides, indent, mode, path, depth);
  return jsonLeaf(field, overrides, mode);
}

function jsonLeaf(field: PromptField, overrides: PromptOverrides, mode: SkelMode): string {
  if (mode === "inline") return `"${escapeJson(inlineContent(field, overrides))}"`;
  const value = exampleValue(field, overrides);
  return isNumericOrBoolean(field.kind, value) ? value : `"${escapeJson(value)}"`;
}

function canExpand(field: PromptField, path: Set<OutputFormatSpec>, depth: number): boolean {
  return field.kind === FieldKind.OBJECT && field.nested != null
    && depth < MAX_NEST_DEPTH && !path.has(field.nested);
}

function jsonObjectField(
  field: PromptField, overrides: PromptOverrides, indent: string,
  mode: SkelMode, path: Set<OutputFormatSpec>, depth: number,
): string {
  if (!canExpand(field, path, depth)) return jsonLeaf(field, overrides, mode);
  const nested = field.nested!;
  path.add(nested);
  const out = jsonObject(nested, overrides, indent, mode, path, depth + 1);
  path.delete(nested);
  return out;
}

function jsonArray(
  field: PromptField, overrides: PromptOverrides, indent: string,
  mode: SkelMode, path: Set<OutputFormatSpec>, depth: number,
): string {
  const elemIndent = indent + INDENT;
  let elem: string;
  if (canExpand(field, path, depth)) {
    const nested = field.nested!;
    path.add(nested);
    elem = jsonObject(nested, overrides, elemIndent, mode, path, depth + 1);
    path.delete(nested);
  } else {
    elem = jsonLeaf(field, overrides, mode);
  }
  return `[\n${elemIndent}${elem}\n${indent}]`;
}

// ---- XML skeleton (recursive) ----------------------------------------------

function renderXmlSkeleton(spec: OutputFormatSpec, overrides: PromptOverrides, mode: SkelMode): string {
  return `<${spec.rootName}>\n${xmlBody(spec, overrides, INDENT, mode, new Set<OutputFormatSpec>([spec]), 0)}</${spec.rootName}>`;
}

function xmlBody(
  spec: OutputFormatSpec, overrides: PromptOverrides, indent: string,
  mode: SkelMode, path: Set<OutputFormatSpec>, depth: number,
): string {
  return spec.fields.map((field) => xmlField(field, overrides, indent, mode, path, depth)).join("");
}

function xmlField(
  field: PromptField, overrides: PromptOverrides, indent: string,
  mode: SkelMode, path: Set<OutputFormatSpec>, depth: number,
): string {
  if (canExpand(field, path, depth)) {
    const nested = field.nested!;
    path.add(nested);
    const body = xmlBody(nested, overrides, indent + INDENT, mode, path, depth + 1);
    path.delete(nested);
    return `${indent}<${field.name}>\n${body}${indent}</${field.name}>\n`;
  }
  const content = mode === "inline" ? inlineContent(field, overrides) : exampleValue(field, overrides);
  return `${indent}<${field.name}>${escapeXml(content)}</${field.name}>\n`;
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
  // same guard as the extract engine's parseFiniteNumber (keeps the JSON valid + parity).
  const t = value.trim();
  if (t === "" || /^[+-]?0[xXbBoO]/.test(t)) return false;
  return Number.isFinite(Number(t));
}
