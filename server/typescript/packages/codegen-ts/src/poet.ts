// The code-printing primitives every TypeScript generator builds its output with: `code`,
// `imp`, `joinCode` and the `Code` / `Import` nodes they produce.
//
// Vendored from ts-poet 6.12.0 (https://github.com/stephenh/ts-poet, commit bda410a1),
// Copyright Stephen Haberman, Apache License 2.0 — the licence text ships with this package
// as `LICENSE.ts-poet`. Only the part the generators use is kept: no `saveFiles`,
// `conditionalOutput` or the CommonJS import fix-ups, and `toString` takes `path`,
// `importExtensions` and `format` only.
//
// WHY VENDORED: ts-poet `require`s `dprint-node` when it loads, and dprint-node ships all
// seven of its platform binaries in one package (~25 MB on every CLI install, of which a
// machine can run one). This copy formats with the SAME dprint TypeScript plugin, built to
// WebAssembly (`@dprint/typescript`, pinned to 0.87.1 — the plugin dprint-node 1.0.8
// compiles in), configured exactly as ts-poet configured dprint-node, so the generated text
// is byte-identical to what ts-poet printed. Bump that pin only together with the goldens.
//
// ONE COPY PER PROCESS: a `Code` placeholder is recognised by `instanceof`, so every module
// that composes `Code` must import it from here (inside this package) or from
// `@metaobjectsdev/codegen-ts/engine` (everywhere else) — the 0.21.6 split-tree defect.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { createFromBuffer, type Formatter } from "@dprint/formatter";

/** Options for `toString`, i.e. for the top-level, per-file output. */
export interface ToStringOpts {
  /** The intended file name of this code; imports from this file itself are dropped. */
  path?: string;
  /** How to handle file extensions in imports: kept (`true`), dropped (`false`), or rewritten to `.js` / `.ts`. */
  importExtensions?: boolean | "ts" | "js";
  /** Whether to run the dprint pass (default `true`). */
  format?: boolean;
}

// ---------------------------------------------------------------------------
// nodes
// ---------------------------------------------------------------------------

export abstract class Node {
  /** Return the unformatted code for this node. */
  abstract toCodeString(): string;

  /** Any potentially string/Import/Code nested nodes within us. */
  abstract get childNodes(): unknown[];
}

// No member is `private`: a private member makes a class NOMINAL in TypeScript, and this
// package's own src/ and the published dist/ declare two `Code` types that a reference
// template mixes (it reaches templates by relative path and the engine by package entry).
// ts-poet never hit this because both sides resolved one `.d.ts`. The members marked
// `@internal` are still not API.
export class Code extends Node {
  // Used by joinCode
  public trim = false;
  // Cache the unformatted results of `toString` since we're immutable.
  /** @internal */
  code: string | undefined;
  /** @internal */
  codeWithImports: string | undefined;

  constructor(
    /** @internal */
    readonly literals: readonly string[],
    /** @internal */
    readonly placeholders: unknown[],
  ) {
    super();
  }

  /** Returns the formatted code, with imports. */
  override toString(opts: ToStringOpts = {}): string {
    this.codeWithImports ??= this.generateCodeWithImports(opts);
    return opts.format === false ? this.codeWithImports : maybePretty(this.codeWithImports);
  }

  get childNodes(): unknown[] {
    return this.placeholders;
  }

  /** Returns the unformatted, import-less code. Internal; `toString` is the public API. */
  toCodeString(): string {
    return (this.code ??= this.generateCode());
  }

  /** @internal */
  deepFindAll(): [Import[], Def[]] {
    const imports: Import[] = [];
    const defs: Def[] = [];
    const todo: unknown[] = [this];
    let i = 0;
    while (i < todo.length) {
      const placeholder = todo[i++];
      if (placeholder instanceof Node) {
        todo.push(...placeholder.childNodes);
      } else if (Array.isArray(placeholder)) {
        todo.push(...placeholder);
      }
      if (placeholder instanceof Import) {
        imports.push(placeholder);
      } else if (placeholder instanceof Def) {
        defs.push(placeholder);
      }
    }
    return [imports, defs];
  }

  /** @internal */
  generateCode(): string {
    const { literals, placeholders } = this;
    let result = "";
    // interleave the literals with the placeholders
    for (let i = 0; i < placeholders.length; i++) {
      result += literals[i] + deepGenerate(placeholders[i]);
    }
    // add the last literal
    result += literals[literals.length - 1];
    if (this.trim) {
      result = result.trim();
    }
    return result;
  }

  /** @internal */
  generateCodeWithImports(opts: ToStringOpts): string {
    const { path: filePath = "", importExtensions = true } = opts;
    const ourModulePath = filePath.replace(/\.[tj]sx?/, "");
    const [imports, defs] = this.deepFindAll();
    assignAliasesIfNeeded(defs, imports, ourModulePath);
    const importPart = emitImports(imports, ourModulePath, importExtensions);
    const bodyPart = this.generateCode();
    return importPart + "\n" + bodyPart;
  }
}

function deepGenerate(object: unknown): string {
  let result = "";
  const todo: unknown[] = [object];
  let i = 0;
  while (i < todo.length) {
    const current = todo[i++];
    if (Array.isArray(current)) {
      todo.push(...current);
    } else if (current instanceof Node) {
      result += current.toCodeString();
    } else if (current === null) {
      result += "null";
    } else if (current !== undefined) {
      result += isPlainObject(current) ? JSON.stringify(current) : (current as { toString(): string }).toString();
    } else {
      result += "undefined";
    }
  }
  return result;
}

/** Finds any namespace collisions of a named import colliding with a def and gives the import an alias. */
function assignAliasesIfNeeded(defs: Def[], imports: Import[], ourModulePath: string): void {
  // Keep track of used (whether declared or imported) symbols
  const usedSymbols = new Set<string>();
  // Mark all locally-defined symbols as used
  defs.forEach((d) => usedSymbols.add(d.symbol));
  // A mapping of original to assigned alias, i.e. Foo@foo --> Foo2
  const assignedAliases: Record<string, string> = {};
  let j = 1;
  imports.forEach((i) => {
    if (
      i instanceof ImportsName &&
      // Don't bother aliasing imports from our own module
      !(sameModule(i.source, ourModulePath) || (i.definedIn && sameModule(i.definedIn, ourModulePath)))
    ) {
      const key = `${i.symbol}@${i.source}`;
      if (usedSymbols.has(i.symbol)) {
        let alias = assignedAliases[key];
        if (!alias) {
          alias = `${i.symbol}${j++}`;
          assignedAliases[key] = alias;
        }
        // Move the original symbol over
        if (alias !== i.symbol) {
          i.sourceSymbol = i.symbol;
        }
        i.symbol = alias;
      } else {
        usedSymbols.add(i.symbol);
        assignedAliases[key] = i.symbol;
      }
    }
  });
}

/**
 * A symbol defined in the current file, so an import of the same name from another file is
 * aliased instead of colliding.
 */
export class Def extends Node {
  constructor(public symbol: string) {
    super();
  }

  toCodeString(): string {
    return this.symbol;
  }

  get childNodes(): Node[] {
    return [];
  }
}

/** A literal source representation of the provided object. */
export class Literal extends Node {
  private readonly tokens: (string | Node)[];

  constructor(object: unknown) {
    super();
    this.tokens = flatten(object);
  }

  get childNodes(): unknown[] {
    return this.tokens;
  }

  toCodeString(): string {
    return this.tokens.map((node) => (typeof node === "string" ? node : node.toCodeString())).join(" ");
  }
}

function flatten(o: unknown): (string | Node)[] {
  if (typeof o === "undefined") {
    return ["undefined"];
  }
  if (typeof o === "object" && o != null) {
    if (o instanceof Node) {
      return [o];
    } else if (Array.isArray(o)) {
      const nodes: (string | Node)[] = ["["];
      for (let i = 0; i < o.length; i++) {
        if (i !== 0) nodes.push(",");
        nodes.push(...flatten(o[i]));
      }
      nodes.push("]");
      return nodes;
    } else if (isPlainObject(o)) {
      const nodes: (string | Node)[] = ["{"];
      const entries = Object.entries(o);
      for (let i = 0; i < entries.length; i++) {
        if (i !== 0) nodes.push(",");
        const [key, value] = entries[i]!;
        nodes.push(JSON.stringify(key), ":", ...flatten(value));
      }
      nodes.push("}");
      return nodes;
    }
  }
  return [JSON.stringify(o)];
}

// is-plain-object <https://github.com/jonschlinkert/is-plain-object>,
// Copyright (c) 2014-2017, Jon Schlinkert. Released under the MIT License.
function isPlainObject(o: unknown): boolean {
  if (o === null || o === undefined) return false;
  if (!isObject(o)) return false;
  // If has modified constructor
  const ctor: unknown = (o as { constructor?: unknown }).constructor;
  if (ctor === undefined) return true;
  // If has modified prototype
  const proto: unknown = (ctor as { prototype?: unknown }).prototype;
  if (!isObject(proto)) return false;
  // If constructor does not have an Object-specific method
  if (!Object.prototype.hasOwnProperty.call(proto, "isPrototypeOf")) return false;
  // Most likely a plain Object
  return true;
}

function isObject(o: unknown): boolean {
  return Object.prototype.toString.call(o) === "[object Object]";
}

// ---------------------------------------------------------------------------
// imports
// ---------------------------------------------------------------------------

const typeImportMarker = "(?:t:)?";
const modulePattern = `.+`;
const identPattern = `(?:(?:[a-zA-Z][_a-zA-Z0-9]*)|(?:[_a-zA-Z][_a-zA-Z0-9]+))`;
const importType = "[*@+=]";
const importPattern = `^(${typeImportMarker}${identPattern})(\\.${identPattern})?(${importType})(${modulePattern})`;
// This is for doing `SourceSymbol:ImportSymbol`
const sourceIdentPattern = `(?:(?:${identPattern}:)?)`;
const sourceImportPattern = `^(${typeImportMarker}${sourceIdentPattern}${identPattern})(\\.${identPattern})?(@)(${modulePattern})`;

/** A symbol and its origin, either via import or implicit/local declaration. */
export abstract class Import extends Node {
  /**
   * Parses a symbol spec: `symbolName importType modulePath`, where `importType` is
   * `@` (named: `Foo@bar` → `import { Foo } from 'bar'`, `t:Foo@bar` for `import type`,
   * `Foo:Bar@baz` for `import { Foo as Bar }`), `*` (star: `Foo*foo` → `import * as Foo from 'foo'`),
   * `=` (default: `Foo=foo` → `import Foo from 'foo'`) or `+` (side effect: `Foo+foo` →
   * `import 'foo'`). A spec that matches none of these is an implicit, untracked symbol.
   */
  static from(spec: string): Import {
    let matched = spec.match(importPattern);
    if (matched === null) {
      matched = spec.match(sourceImportPattern);
    }
    if (matched != null) {
      const modulePath = matched[4]!;
      const childSymbol = matched[2]?.substring(1) || undefined; // I.e. `Transaction` in `Knex.Transaction`
      const kind = matched[3] || "@";
      const symbolName = matched[1] || "";
      switch (kind) {
        case "*":
          return Import.importsAll(symbolName, modulePath);
        case "@": {
          const isTypeImport = symbolName.startsWith("t:");
          const exportedNames = (isTypeImport ? symbolName.substring(2) : symbolName).split(":");
          const exportedName = exportedNames.pop()!;
          const sourceExportedName = exportedNames[0];
          return Import.importsName(exportedName, modulePath, isTypeImport, sourceExportedName, childSymbol);
        }
        case "=":
          return Import.importsDefault(symbolName, modulePath);
        case "+":
          return Import.sideEffect(symbolName, modulePath);
        default:
          throw new Error("Invalid import kind character");
      }
    }
    return Import.implicit(spec);
  }

  /**
   * Defined if the symbol is typically imported from a barrel/etc. path, but is technically
   * defined in another file — so no import is emitted when it is used in that file.
   */
  definedIn?: string;

  protected constructor(public symbol: string) {
    super();
  }

  toCodeString(): string {
    return this.symbol;
  }

  get childNodes(): unknown[] {
    return [];
  }

  abstract source: string | undefined;

  /** `import * as Engine from 'templates';` */
  static importsAll(localName: string, from: string): Import {
    return new ImportsAll(localName, from);
  }

  /** `import { Engine } from 'templates';` / `import { Foo as Bar } from 'templates';` */
  static importsName(
    exportedName: string,
    from: string,
    typeImport: boolean,
    sourceSymbol?: string,
    childSymbol?: string,
  ): Import {
    return new ImportsName(exportedName, from, sourceSymbol, typeImport, childSymbol);
  }

  /** `import 'mocha'` */
  static sideEffect(symbolName: string, from: string): Import {
    return new SideEffect(symbolName, from);
  }

  /** An implied symbol that does no tracking of imports. */
  static implicit(name: string): Import {
    return new Implicit(name);
  }

  /** `import Engine from 'engine';` */
  static importsDefault(exportedName: string, from: string): Import {
    return new ImportsDefault(exportedName, from);
  }
}

/** Non-imported symbol. */
export class Implicit extends Import {
  constructor(symbol: string) {
    super(symbol);
  }

  source = undefined;
}

/** Common base class for imported symbols. */
export abstract class Imported extends Import {
  /** The symbol is the imported symbol, i.e. `BarClass`, and source is the path it comes from. */
  protected constructor(
    public override symbol: string,
    public source: string,
  ) {
    super(source);
  }
}

/** `import { Engine } from 'templates'` or `import { Engine as Engine2 } from 'templates'`. */
export class ImportsName extends Imported {
  constructor(
    symbol: string,
    source: string,
    /** The original symbol when renaming, i.e. `Engine` in `Engine as Engine2`. */
    public sourceSymbol?: string,
    /** Whether this is an `import type` import. */
    public typeImport?: boolean,
    /** The `Transaction` in a `Knex.Transaction`. */
    public childSymbol?: string,
  ) {
    super(symbol, source);
  }

  toImportPiece(skipTypeImport = false): string {
    const maybeTypePrefix = this.typeImport && !skipTypeImport ? "type " : "";
    return maybeTypePrefix + (this.sourceSymbol ? `${this.sourceSymbol} as ${this.symbol}` : this.symbol);
  }

  override toCodeString(): string {
    return this.childSymbol ? `${this.symbol}.${this.childSymbol}` : this.symbol;
  }
}

/** `import Engine from 'engine';` */
export class ImportsDefault extends Imported {
  constructor(symbol: string, source: string) {
    super(symbol, source);
  }
}

/** `import * as Engine from 'templates';` */
export class ImportsAll extends Imported {
  constructor(symbol: string, source: string) {
    super(symbol, source);
  }
}

/** A symbol brought in as a side effect of an import: `Foo+mocha` adds `import 'mocha'`. */
export class SideEffect extends Imported {
  constructor(symbol: string, source: string) {
    super(symbol, source);
  }
}

/** Generates the `import ...` lines for the given `imports`. */
function emitImports(imports: Import[], ourModulePath: string, importExtensions: boolean | "js" | "ts"): string {
  if (imports.length == 0) {
    return "";
  }
  let result = "";

  // Group the imports by source module they're imported from
  const importsByModule = groupBy(
    imports.filter(
      (it) =>
        it.source !== undefined &&
        // Ignore imports that are in our own file
        !(it instanceof ImportsName && it.definedIn && sameModule(it.definedIn, ourModulePath)),
    ),
    (it) => it.source!,
  );

  // Output each source module as one line
  Object.entries(importsByModule).forEach(([modulePath, imports]) => {
    // Skip imports from the current module
    if (sameModule(ourModulePath, modulePath)) return;
    const importPath = maybeAdjustExtension(maybeRelativePath(ourModulePath, modulePath), importExtensions);

    // Output star imports individually
    unique(filterInstances(imports, ImportsAll).map((i) => i.symbol)).forEach((symbol) => {
      result += `import * as ${symbol} from '${importPath}';\n`;
    });

    // Partition named imported into `import type` vs. regular imports
    const symbolImports = filterInstances(imports, ImportsName).filter((it) => !it.typeImport);
    const typeImports = filterInstances(imports, ImportsName).filter(
      (it) => !!it.typeImport && !symbolImports.some((s) => s.symbol === it.symbol),
    );
    // Use `import type { ... }` when every named import from the module is a type
    const useSingleTypeImport = typeImports.length > 0 && symbolImports.length === 0;
    const namedImports = useSingleTypeImport
      ? unique(typeImports.map((it) => it.toImportPiece(true)))
      : unique([...typeImports, ...symbolImports].map((it) => it.toImportPiece()));
    const defaultImports = unique(filterInstances(imports, ImportsDefault).map((it) => it.symbol));
    if (namedImports.length > 0 || defaultImports.length > 0) {
      // Output named imports as a group
      const namesPart = namedImports.length > 0 ? [`{ ${namedImports.join(", ")} }`] : [];
      const defPart = defaultImports.length > 0 ? [defaultImports[0]] : [];
      result += `import${useSingleTypeImport ? " type" : ""} ${[...defPart, ...namesPart].join(", ")} from '${importPath}';\n`;
    }
  });

  const sideEffectImports = groupBy(filterInstances(imports, SideEffect), (a) => a.source);
  Object.keys(sideEffectImports).forEach((it) => (result += `import '${it}';\n`));

  return result;
}

function groupBy<T>(list: T[], fn: (x: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  list.forEach((o) => {
    (result[fn(o)] ??= []).push(o);
  });
  return result;
}

function filterInstances<U>(list: readonly unknown[], t: abstract new (...args: never[]) => U): U[] {
  return list.filter((e): e is U => e instanceof t);
}

function unique<T>(list: T[]): T[] {
  return [...new Set(list)];
}

function maybeRelativePath(outputPath: string, importPath: string): string {
  if (!importPath.startsWith("./")) {
    return importPath;
  }
  importPath = path.normalize(importPath);
  outputPath = path.normalize(outputPath);
  const outputPathDir = path.dirname(outputPath);
  if (outputPathDir === importPath) {
    // importing a file that is named the same thing as the directory the file doing the importing is in.
    // e.g. importing `./foo` from `./foo/index.ts` reads `../foo`, not `./`
    return ".." + path.sep + path.basename(importPath);
  }
  let relativePath = path.relative(outputPathDir, importPath).split(path.sep).join(path.posix.sep);
  if (!relativePath.startsWith(".")) {
    // ensure the js compiler recognizes this is a relative path.
    relativePath = "./" + relativePath;
  }
  return relativePath;
}

const extensionRegex = /\.[tj]sx?/;

function maybeAdjustExtension(p: string, importExtensions: boolean | "js" | "ts"): string {
  if (importExtensions === true) return p;
  if (importExtensions === false) return p.replace(extensionRegex, "");
  if (importExtensions === "js") return p.replace(/\.ts$/, ".js").replace(/\.tsx$/, ".jsx");
  return p.replace(/\.js$/, ".ts").replace(/\.jsx$/, ".tsx");
}

/** Checks if `path1 === path2` despite minor path differences like `./foo` and `foo`. */
function sameModule(path1: string, path2: string): boolean {
  // TypeScript: import paths ending in .js and .ts are resolved to the .ts file.
  const [basePath1, basePath2] = [path1, path2].map((p) => p.replace(extensionRegex, "")) as [string, string];
  return basePath1 === basePath2 || path.resolve(basePath1) === path.resolve(basePath2);
}

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

// ts-poet's dprint configuration, unchanged: "prettier-ish", plus forced braces and new
// lines because the pre-formatted output is all bunched together. `deno: true` is the base
// dprint-node applied before these overrides.
const DPRINT_CONFIG = {
  deno: true,
  useTabs: false,
  useBraces: "always",
  singleBodyPosition: "nextLine",
  "arrowFunction.useParentheses": "force",
  "module.sortImportDeclarations": "caseSensitive",
  lineWidth: 120,
  preferSingleLine: true,
};

let formatter: Formatter | undefined;

function dprint(): Formatter {
  if (formatter === undefined) {
    const wasm = readFileSync(createRequire(import.meta.url).resolve("@dprint/typescript/plugin.wasm"));
    formatter = createFromBuffer(wasm);
    formatter.setConfig({}, DPRINT_CONFIG);
  }
  return formatter;
}

function maybePretty(input: string): string {
  // Loading the formatter stays outside the try: a missing or broken @dprint/typescript must
  // fail loudly (as dprint-node's import-time load did), not silently emit unformatted code.
  const fmt = dprint();
  try {
    return fmt.formatText({ filePath: "file.ts", fileText: input.trim() });
  } catch {
    return input; // assume it's invalid syntax and ignore
  }
}

// ---------------------------------------------------------------------------
// combinators
// ---------------------------------------------------------------------------

/** A template literal to format code and auto-organize imports. */
export function code(literals: TemplateStringsArray, ...placeholders: unknown[]): Code {
  return new Code(
    literals,
    placeholders.map((p) => (isPlainObject(p) ? literalOf(p) : p)),
  );
}

export function literalOf(object: unknown): Node {
  return new Literal(object);
}

export function joinCode(chunks: Code[], opts: { on?: string; trim?: boolean } = {}): Code {
  const { on = "", trim = true } = opts;
  const literals: string[] = [""];
  for (let i = 0; i < chunks.length - 1; i++) {
    literals.push(on);
  }
  literals.push("");
  if (trim) {
    chunks.forEach((c) => (c.trim = true));
  }
  return new Code(literals, chunks);
}

/** Creates an import that will be auto-imported at the top of the output file. */
export function imp(spec: string, opts: { definedIn?: string } = {}): Import {
  const sym = Import.from(spec);
  if (opts.definedIn) {
    sym.definedIn = opts.definedIn;
  }
  return sym;
}

/** Defines `symbol` as being locally defined in the file, to avoid import collisions. */
export function def(symbol: string): Def {
  return new Def(symbol);
}
