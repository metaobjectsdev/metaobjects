// The declarative JSON template-spec the CLI ports (C#/Python) consume, and TS
// can spread into `generators`. The JSON shape is the cross-port contract
// (SP-1 §4); a JSON Schema (template-spec.schema.json) sits beside it.
import type { RenderFormat } from "@metaobjectsdev/render";
import type { Generator } from "../generator.js";
import { templateGenerator, type TemplateScope } from "../generators/template-generator.js";

const SCOPES = ["perEntity", "perPackage", "perModel"] as const satisfies readonly TemplateScope[];

export interface TemplateSpecEntry {
  name: string;
  template: string;
  scope: TemplateScope;
  outputPattern: string;
  format?: RenderFormat;
  target?: string;
}
export interface TemplateSpecFile { generators: TemplateSpecEntry[]; }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate + narrow an untyped JSON value into a TemplateSpecFile. Throws on
 *  any shape violation (missing/empty required string, bad scope, non-object). */
export function parseTemplateSpec(json: unknown): TemplateSpecFile {
  if (!isRecord(json) || !Array.isArray(json.generators)) {
    throw new Error("template-spec: expected an object with a `generators` array");
  }
  const generators = json.generators.map((raw, i): TemplateSpecEntry => {
    if (!isRecord(raw)) throw new Error(`template-spec generators[${i}]: expected an object`);
    for (const key of ["name", "template", "scope", "outputPattern"] as const) {
      if (typeof raw[key] !== "string" || raw[key] === "") {
        throw new Error(`template-spec generators[${i}]: missing or empty required string '${key}'`);
      }
    }
    if (!SCOPES.includes(raw.scope as TemplateScope)) {
      throw new Error(
        `template-spec generators[${i}]: scope must be one of ${SCOPES.join(" | ")}, got '${String(raw.scope)}'`,
      );
    }
    const entry: TemplateSpecEntry = {
      name: raw.name as string,
      template: raw.template as string,
      scope: raw.scope as TemplateScope,
      outputPattern: raw.outputPattern as string,
    };
    if (typeof raw.format === "string") entry.format = raw.format as RenderFormat;
    if (typeof raw.target === "string") entry.target = raw.target;
    return entry;
  });
  return { generators };
}

/** Map a parsed spec into runnable Generators (one templateGenerator per entry). */
export function templateSpecToGenerators(spec: TemplateSpecFile): Generator[] {
  return spec.generators.map((e) =>
    templateGenerator({
      name: e.name,
      template: e.template,
      scope: e.scope,
      outputPattern: e.outputPattern,
      ...(e.format !== undefined ? { format: e.format } : {}),
      ...(e.target !== undefined ? { target: e.target } : {}),
    }),
  );
}
