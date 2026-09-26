// `meta generator new <name>` — scaffold a generator of YOUR OWN (ADR-0034 Amendment 4).
//
// MetaObjects' product is the core — the model, loader, `verify`, `migrate`, render and
// extract. Every output an application needs beyond the reference generators (OpenAPI, JSON
// Schema, a client, a DTO layer, docs) is a generator the adopter writes. This command makes
// the first minute of that cheap: it writes a working, commented generator into
// codegen/generators/ and wires it into metaobjects.config.ts, so `meta gen` runs it and
// `meta verify --codegen` gates it before the author has changed a line.
//
// It is deliberately NOT eject: eject copies a reference generator; this writes a new one.
// The two share only the dependency report.

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { catalogEntry } from "../lib/catalog.js";
import { log } from "../lib/log.js";
import { dependencyNotesForTemplate } from "./eject.js";
import {
  CONFIG_FILE,
  GENERATOR_OPTIONS,
  GENERATOR_SCOPES,
  OWNED_GENERATORS_DIR,
  type GeneratorScope,
} from "./generator-help.js";

export { GENERATOR_HELP, GENERATOR_OPTIONS, GENERATOR_SCOPES, OWNED_GENERATORS_DIR } from "./generator-help.js";
export type { GeneratorScope } from "./generator-help.js";

const NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** kebab-case → the exported factory's name: `json-schema` → `jsonSchemaGenerator`. */
export function factoryNameFor(name: string): string {
  const camel = name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  return `${camel}Generator`;
}

// ---------------------------------------------------------------------------
// The skeleton
// ---------------------------------------------------------------------------

const HEADER = (name: string, scope: GeneratorScope) => `// ${name} — a generator of your own. It is yours: edit it freely; no MetaObjects release
// changes it. Scaffolded by \`meta generator new ${name} --scope ${scope}\`.
//
// HOW IT RUNS. metaobjects.config.ts lists it in \`generators: [...]\`. \`meta gen\` calls
// generate() with the loaded model and writes each returned { path, content } under outDir
// (paths are relative to it). \`meta verify --codegen\` re-runs it and fails when committed
// output is stale — nothing to register for that. Typecheck this file with
//   npx tsc -p tsconfig.codegen.json
// because \`meta gen\` loads it WITHOUT typechecking.
//
// READING THE MODEL (it is read-only — never mutate it):
//   ctx.entities            EVERY object: entities, value objects, projections AND abstract
//                           bases. The \`filter\` below decides which ones you get.
//   obj.name / effectivePackage(obj)       the object's name and its package (or undefined)
//   obj.fields()            all fields, INCLUDING those inherited through \`extends\`
//   field.subType           "string" | "long" | "enum" | "object" | ... (\`meta types field\`)
//   field.isRequired, field.maxLength, field.precision, field.scale
//   field.resolvedIsArray() array-ness, inherited too
//   field.attr("description")   any attribute's effective value (own, else inherited)
//   enumValues(field)       a field.enum's members
//   objectRefTarget(field)  the object a field.object points at (package-aware)
//   obj.primaryIdentity()?.fields          the primary-key field names
//
// THE ONE RULE (ADR-0039): always read through the accessors above. The own*() forms
// (ownFields, ownAttr, ownChildren) and the raw \`isArray\` flag skip everything an object or
// field inherits through \`extends\` — the output compiles and is silently wrong.
//
// NAMING: toCamelCase / toPascalCase / toSnakeCase / pluralize, and servedPath(obj, prefix)
// for the REST address the reference routes serve, all from "@metaobjectsdev/codegen-ts".
// The config's apiPrefix reaches you as ctx.renderContext?.apiPrefix.
`;

/** Exactly the names the scope's skeleton uses — an unused import fails a strict tsconfig. */
function importsFor(scope: GeneratorScope): string {
  const names = ["effectivePackage", "enumValues", "isAbstract", "objectRefTarget", HELPER_BY_SCOPE[scope]];
  if (scope !== "model") names.push("packageToPath");
  const list = names.sort().map((n) => `  ${n},\n`).join("");
  return `import {\n${list}  type Generator,\n} from "@metaobjectsdev/codegen-ts";\n` +
    `import type { MetaField, MetaObject } from "@metaobjectsdev/metadata";\n`;
}

const DESCRIBE_FIELD = `
/** One field, described. Replace this with whatever your output needs per field. */
function describeField(field: MetaField): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: field.name,
    type: field.subType,
    required: field.isRequired,
    array: field.resolvedIsArray(),
  };
  if (field.maxLength !== undefined) out.maxLength = field.maxLength;
  const members = enumValues(field);
  if (members !== undefined) out.values = members;
  const target = objectRefTarget(field);
  if (target !== undefined) out.ref = target.resolutionKey();
  return out;
}

const describeObject = (obj: MetaObject) => ({
  name: obj.name,
  package: effectivePackage(obj) ?? null,
  fields: obj.fields().map(describeField),
});
`;

const FACTORY_HEAD = (name: string, factory: string) => `
export interface ${factory.charAt(0).toUpperCase()}${factory.slice(1)}Opts {
  /** Narrow which objects this generator sees (ANDed with the default filter below). */
  filter?: (obj: MetaObject) => boolean;
  /** Named output target from the config's \`targets\`; omit for the top-level outDir. */
  target?: string;
}

export function ${factory}(opts: ${factory.charAt(0).toUpperCase()}${factory.slice(1)}Opts = {}): Generator {
  const generator: Generator = {
    name: "${name}",
    // Which objects: here, every concrete one. Abstract bases only contribute fields to
    // what \`extends\` them. Other predicates to compose: hasAnyRdbSource (persisted),
    // servesReadApi / servesWriteApi (has reference routes), isProjection.
    filter: (obj) => !isAbstract(obj) && (opts.filter?.(obj) ?? true),
`;

const FACTORY_TAIL = `  };
  if (opts.target !== undefined) generator.target = opts.target;
  return generator;
}
`;

const GENERATE_BY_SCOPE: Record<GeneratorScope, (name: string) => string> = {
  entity: (name) => `    // perEntity: generate() runs once per matched object; return one file (or an array).
    generate: perEntity((obj) => {
      const pkg = effectivePackage(obj);
      const dir = pkg === undefined ? "${name}" : \`${name}/\${packageToPath(pkg)}\`;
      return {
        path: \`\${dir}/\${obj.name}.json\`,
        content: \`\${JSON.stringify(describeObject(obj), null, 2)}\\n\`,
      };
    }),
`,
  package: (name) => `    // perPackage: generate() runs once per metadata package with that package's objects.
    generate: perPackage((pkg, objects) => ({
      path: \`${name}/\${pkg === "" ? "_root" : packageToPath(pkg)}.json\`,
      content: \`\${JSON.stringify({ package: pkg, objects: objects.map(describeObject) }, null, 2)}\\n\`,
    })),
`,
  model: (name) => `    // perModel: generate() runs once with every matched object; return one file (or more).
    generate: perModel((objects) => ({
      path: "${name}.json",
      content: \`\${JSON.stringify({ objects: objects.map(describeObject) }, null, 2)}\\n\`,
    })),
`,
};

const HELPER_BY_SCOPE: Record<GeneratorScope, string> = {
  entity: "perEntity",
  package: "perPackage",
  model: "perModel",
};

/** The generator source `meta generator new` writes. Exported for the gate that runs it. */
export function renderGeneratorSkeleton(name: string, scope: GeneratorScope): string {
  const factory = factoryNameFor(name);
  return [
    HEADER(name, scope),
    importsFor(scope),
    DESCRIBE_FIELD,
    FACTORY_HEAD(name, factory),
    GENERATE_BY_SCOPE[scope](name),
    FACTORY_TAIL,
  ].join("");
}

// ---------------------------------------------------------------------------
// Wiring the config
// ---------------------------------------------------------------------------

export interface WireResult {
  status: "wired" | "already-wired" | "manual";
  source: string;
}

/**
 * Index of the `]` closing the `[` at `open`, skipping string literals, template literals
 * and comments so a bracket inside `"a]b"` does not end the array. -1 if unbalanced.
 */
function matchingBracket(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2);
      if (i === -1) return -1;
      i++;
      continue;
    }
    if (c === "[" || c === "(" || c === "{") depth++;
    else if (c === "]" || c === ")" || c === "}") {
      depth--;
      if (depth === 0) return c === "]" ? i : -1;
    }
  }
  return -1;
}

/**
 * Add `importLine` after the config's last top-level import and `entry` to the end of its
 * `generators: [...]` array. Edits only a config it can read unambiguously — exactly one
 * literal `generators: [` array — and otherwise returns `manual` with the source untouched,
 * so the caller prints the two lines instead of guessing.
 */
export function wireGeneratorIntoConfig(source: string, importLine: string, entry: string): WireResult {
  if (source.includes(importLine)) return { status: "already-wired", source };

  const arrays = [...source.matchAll(/\bgenerators\s*:\s*\[/g)];
  if (arrays.length !== 1) return { status: "manual", source };
  const open = arrays[0]!.index! + arrays[0]![0].length - 1;
  const close = matchingBracket(source, open);
  if (close === -1) return { status: "manual", source };

  const inner = source.slice(open + 1, close);
  let newInner: string;
  if (inner.trim() === "") {
    newInner = entry;
  } else if (inner.includes("\n")) {
    // Multi-line: a new line at the indent of the last element, keeping the closing line.
    const trailing = inner.slice(inner.trimEnd().length);          // "\n  " before `]`
    const body = inner.trimEnd();
    const lastLine = body.slice(body.lastIndexOf("\n") + 1);
    const indent = lastLine.slice(0, lastLine.length - lastLine.trimStart().length);
    // A trailing line comment means the element's comma sits before the comment.
    const hasComma = /,\s*(\/\/[^\n]*)?$/.test(body);
    newInner = `${body}${hasComma ? "" : ","}\n${indent}${entry},${trailing}`;
  } else {
    const body = inner.trimEnd();
    newInner = body.endsWith(",") ? `${body} ${entry}` : `${body}, ${entry}`;
  }
  let out = source.slice(0, open + 1) + newInner + source.slice(close);

  // The import: after the last line that starts an import statement (and its `from` line).
  const importRe = /^import[\s\S]*?from\s+["'][^"']+["'];?[^\n]*$/gm;
  let lastEnd = -1;
  for (const m of out.matchAll(importRe)) lastEnd = m.index! + m[0].length;
  out = lastEnd === -1
    ? `${importLine}\n${out}`
    : `${out.slice(0, lastEnd)}\n${importLine}${out.slice(lastEnd)}`;
  return { status: "wired", source: out };
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export interface NewGeneratorOptions {
  cwd: string;
  name: string;
  scope?: GeneratorScope;
  force?: boolean;
  wire?: boolean;
}

export interface NewGeneratorResult {
  file: string;
  fileStatus: "created" | "overwritten";
  wireStatus: WireResult["status"] | "skipped";
  importLine: string;
  entry: string;
  dependencyNotes: string[];
}

export async function newGenerator(opts: NewGeneratorOptions): Promise<NewGeneratorResult> {
  const { cwd, name } = opts;
  const scope = opts.scope ?? "entity";
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`generator name "${name}" must be kebab-case (e.g. json-schema, openapi).`);
  }
  if (catalogEntry(name) !== undefined) {
    throw new Error(
      `"${name}" is a reference generator's name. Pick another name for your own generator, ` +
        `or take a copy of that one with \`meta eject ${name}\`.`,
    );
  }
  const configPath = join(cwd, CONFIG_FILE);
  const wire = opts.wire ?? true;
  if (wire && !existsSync(configPath)) {
    throw new Error(`no ${CONFIG_FILE} here — run \`meta init\` first, or pass --no-wire.`);
  }

  const rel = `${OWNED_GENERATORS_DIR}/${name}.ts`;
  const abs = join(cwd, rel);
  const existed = existsSync(abs);
  if (existed && opts.force !== true) {
    throw new Error(`${rel} already exists — it is yours; edit it, or pass --force to replace it.`);
  }
  const source = renderGeneratorSkeleton(name, scope);
  await mkdir(join(cwd, OWNED_GENERATORS_DIR), { recursive: true });
  await writeFile(abs, source, "utf8");

  const factory = factoryNameFor(name);
  const importLine = `import { ${factory} } from "./${OWNED_GENERATORS_DIR}/${name}.js";`;
  const entry = `${factory}()`;

  let wireStatus: NewGeneratorResult["wireStatus"] = "skipped";
  if (wire) {
    const result = wireGeneratorIntoConfig(await readFile(configPath, "utf8"), importLine, entry);
    if (result.status === "wired") await writeFile(configPath, result.source, "utf8");
    wireStatus = result.status;
  }

  return {
    file: rel,
    fileStatus: existed ? "overwritten" : "created",
    wireStatus,
    importLine,
    entry,
    // The same report eject gives, worded for a file nobody ejected.
    dependencyNotes: (await dependencyNotesForTemplate(cwd, source)).map((n) =>
      n.replace(/^The ejected file imports/, "The new generator imports")),
  };
}

export async function generatorCommand(args: string[], cwd: string): Promise<number> {
  let values: { scope?: string; force?: boolean; "no-wire"?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args, options: GENERATOR_OPTIONS, strict: true, allowPositionals: true }));
  } catch (err) {
    log.error((err as Error).message);
    return 2;
  }
  const [sub, name, ...extra] = positionals;
  if (sub !== "new" || name === undefined || extra.length > 0) {
    log.error("usage: meta generator new <name> [--scope entity|package|model]. See `meta generator --help`.");
    return 2;
  }
  const scope = values.scope ?? "entity";
  if (!(GENERATOR_SCOPES as readonly string[]).includes(scope)) {
    log.error(`--scope must be one of ${GENERATOR_SCOPES.join(", ")} (got "${scope}").`);
    return 2;
  }

  let r: NewGeneratorResult;
  try {
    r = await newGenerator({
      cwd,
      name,
      scope: scope as GeneratorScope,
      force: values.force === true,
      wire: values["no-wire"] !== true,
    });
  } catch (err) {
    log.error((err as Error).message);
    return 2;
  }

  const lines = [`${r.fileStatus === "created" ? "Created" : "Overwrote"} ${r.file} — yours to edit.`];
  if (r.wireStatus === "wired") {
    lines.push(`Wired it into ${CONFIG_FILE}: ${r.entry}`);
  } else if (r.wireStatus === "already-wired") {
    lines.push(`${CONFIG_FILE} already imports it.`);
  } else {
    lines.push(
      r.wireStatus === "manual"
        ? `Could not find one literal \`generators: [...]\` in ${CONFIG_FILE} to edit safely. Add:`
        : `Add to ${CONFIG_FILE}:`,
      `  ${r.importLine}`,
      `  generators: [..., ${r.entry}]`,
    );
  }
  lines.push(
    "",
    "Next:",
    "  meta gen                          # runs it; output lands under outDir",
    "  meta verify --codegen             # drift-gates it (no registration needed)",
    "  npx tsc -p tsconfig.codegen.json  # typecheck it — meta gen does not",
    `Then edit ${r.file}: change what it emits, keep reading the model through fields() / attr().`,
  );
  if (r.dependencyNotes.length > 0) lines.push("", ...r.dependencyNotes);
  log.info(lines.join("\n"));
  return 0;
}
