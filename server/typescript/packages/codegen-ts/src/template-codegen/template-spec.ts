// The declarative JSON template-spec the CLI ports (C#/Python) consume, and TS
// can spread into `generators`. The JSON shape is the cross-port contract
// (SP-1 §4); a JSON Schema (template-spec.schema.json) sits beside it.
import { ESCAPERS, type RenderFormat } from "@metaobjectsdev/render";
import type { Generator } from "../generator.js";
import { templateGenerator, type TemplateAssets, type TemplateData, type TemplateScope } from "../generators/template-generator.js";

const SCOPES = ["perEntity", "perPackage", "perModel", "perNode", "perRequirement"] as const satisfies readonly TemplateScope[];
const DATA = ["entities", "docsView"] as const satisfies readonly TemplateData[];
const FORMATS = Object.keys(ESCAPERS) as readonly RenderFormat[];

export interface TemplateSpecEntry {
  name: string;
  template: string;
  scope: TemplateScope;
  outputPattern: string;
  format?: RenderFormat;
  target?: string;
  /** What the template reads: `entities` (the per-entity dictionary) or `docsView`. */
  data?: TemplateData;
  /** perNode / perRequirement: `<type>.<subType>`, `<type>.*` or `*`, or a list of them. */
  match?: string | string[];
  /** The directory under the target the output paths, and a page's `root`, are relative to. */
  subDir?: string;
  /** A directory of static text files, relative to the project, copied under `subDir`. */
  assets?: TemplateAssets;
  /** Fail the run when a relative link in this entry's HTML pages lands on nothing. */
  linkCheck?: boolean;
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
    if (raw.format !== undefined) {
      if (typeof raw.format !== "string" || !FORMATS.includes(raw.format as RenderFormat)) {
        throw new Error(
          `template-spec generators[${i}]: format must be one of ${FORMATS.join(" | ")}, got '${String(raw.format)}'`,
        );
      }
      entry.format = raw.format as RenderFormat;
    }
    if (typeof raw.target === "string") entry.target = raw.target;
    const at = `template-spec generators[${i}]`;
    if (raw.data !== undefined) {
      if (!DATA.includes(raw.data as TemplateData)) {
        throw new Error(`${at}: data must be one of ${DATA.join(" | ")}, got '${String(raw.data)}'`);
      }
      entry.data = raw.data as TemplateData;
    }
    if (raw.match !== undefined) {
      const list = Array.isArray(raw.match) ? raw.match : [raw.match];
      if (list.length === 0 || !list.every((m): m is string => typeof m === "string" && m !== "")) {
        throw new Error(`${at}: match must be a non-empty string or a non-empty list of them`);
      }
      entry.match = Array.isArray(raw.match) ? list : list[0]!;
    }
    if (raw.subDir !== undefined) {
      if (typeof raw.subDir !== "string") throw new Error(`${at}: subDir must be a string`);
      entry.subDir = raw.subDir;
    }
    if (raw.assets !== undefined) {
      const a = raw.assets;
      if (!isRecord(a) || typeof a.from !== "string" || a.from === "" || (a.to !== undefined && typeof a.to !== "string")) {
        throw new Error(`${at}: assets must be { "from": "<dir>", "to"?: "<dir>" }`);
      }
      entry.assets = { from: a.from, ...(typeof a.to === "string" && { to: a.to }) };
    }
    if (raw.linkCheck !== undefined) {
      if (typeof raw.linkCheck !== "boolean") throw new Error(`${at}: linkCheck must be a boolean`);
      entry.linkCheck = raw.linkCheck;
    }
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
      ...(e.data !== undefined && { data: e.data }),
      ...(e.match !== undefined && { match: e.match }),
      ...(e.subDir !== undefined && { subDir: e.subDir }),
      ...(e.assets !== undefined && { assets: e.assets }),
      ...(e.linkCheck !== undefined && { linkCheck: e.linkCheck }),
    }),
  );
}
