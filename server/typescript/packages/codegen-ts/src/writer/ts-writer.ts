// The TypeScript dialect of the code writer (ADR-0063; contract: spec/code-writer.md).
//
// Adds what is TypeScript's own: imports collected while the body is written and printed
// first, string quoting, object literals and doc comments. It also accepts ts-poet `Code`
// fragments, harvesting their `imp()` imports, so a generator can move to the writer one
// function at a time while the rest of it still returns `Code`.

import { Code, Import } from "ts-poet";
import { ImportsAll, ImportsDefault, ImportsName, SideEffect } from "ts-poet/build/Import.js";
import { Node } from "ts-poet/build/Node.js";
import { CodeWriter, type CodeWriterOptions, flat, Group, type Piece, WRITER_ERRORS, WriterError } from "./code-writer.js";

/** A correctly quoted TypeScript string literal. */
export const str = (value: string): string => JSON.stringify(value);

/** An array literal: `[a, b]`. */
export const arr = (items: readonly unknown[]): Group => new Group("[", items as Piece[], "]");

/** A call: `fn(a, b)`. */
export const call = (fn: string, args: readonly unknown[]): Group => new Group(`${fn}(`, args as Piece[], ")");

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** An object key: bare when it is an identifier, quoted otherwise. */
export const key = (name: string): string => (IDENTIFIER.test(name) ? name : str(name));

/** An object literal under construction; members print in the order they are set. */
export class Props extends Group {
  private readonly entries: Piece[];
  constructor() {
    const entries: Piece[] = [];
    super("{", entries, "}", true);
    this.entries = entries;
  }
  /** `name: value`. The name is written as given; use `key()` for one that may need quotes. */
  set(name: string, value: unknown): this {
    this.entries.push([name, ": ", value as Piece]);
    return this;
  }
  /** A member written whole: a shorthand `name`, a spread `...rest` or a method. */
  add(member: unknown): this {
    this.entries.push(member as Piece);
    return this;
  }
}

/** A new, empty object literal. */
export const props = (): Props => new Props();

interface Named {
  readonly exported: string;
  typeOnly: boolean;
}

interface ModuleImports {
  readonly named: Map<string, Named>;
  defaultName?: string;
  readonly namespaces: Set<string>;
  sideEffect: boolean;
}

export interface TsWriterOptions extends CodeWriterOptions {}

export class TsWriter extends CodeWriter {
  private readonly modules = new Map<string, ModuleImports>();
  /** Local name -> the module it was imported from, so one name cannot come from two. */
  private readonly locals = new Map<string, string>();
  private readonly headLines: string[] = [];

  constructor(options: TsWriterOptions = {}) {
    super({ indent: "  ", width: 120, trailingComma: true, ...options });
  }

  /** Reference a value import; returns the name to write. */
  use(name: string, from: string): string {
    return this.addNamed(name, name, from, false);
  }

  /** Reference a type-only import; returns the name to write. */
  useType(name: string, from: string): string {
    return this.addNamed(name, name, from, true);
  }

  /** Reference a module's default export under `name`; returns the name to write. */
  useDefault(name: string, from: string): string {
    this.claim(name, from);
    const m = this.module(from);
    if (m.defaultName !== undefined && m.defaultName !== name) {
      throw new WriterError(WRITER_ERRORS.importConflict, `default of ${str(from)} imported as both ${m.defaultName} and ${name}`);
    }
    m.defaultName = name;
    return name;
  }

  /** Reference a whole module as `import * as name`; returns the name to write. */
  useNamespace(name: string, from: string): string {
    this.claim(name, from);
    this.module(from).namespaces.add(name);
    return name;
  }

  /** Import a module for its side effects only: `import "from";`. */
  useSideEffect(from: string): void {
    this.module(from).sideEffect = true;
  }

  /** Lines printed at the very top, before the imports: a banner comment or a `"use client";` directive. */
  header(...lines: readonly string[]): this {
    this.headLines.push(...lines);
    return this;
  }

  /** A doc comment: one line when it fits, otherwise a block with one ` * ` line per entry. */
  doc(...lines: readonly string[]): this {
    if (lines.length === 0) return this;
    const safe = lines.map((l) => l.replaceAll("*/", "*\\/"));
    const one = `/** ${safe[0]} */`;
    if (safe.length === 1 && this.fits(one)) return this.line(one);
    this.line("/**");
    for (const l of safe) this.line(l === "" ? " *" : ` * ${l}`);
    return this.line(" */");
  }

  /** A ts-poet `Code` fragment, possibly many lines: its imports are collected, its text re-indented. */
  code(fragment: Code): this {
    return this.text(fragment instanceof Code ? this.harvest(fragment) : flat(this.piece(fragment)));
  }

  override toString(): string {
    const head = new CodeWriter({ indent: this.indent, width: this.width, trailingComma: this.trailingComma });
    for (const l of this.headLines) head.line(l);
    head.blank();
    for (const from of sortModules([...this.modules.keys()])) this.writeImport(head, from, this.modules.get(from)!);
    const top = head.toString();
    const body = super.toString();
    if (top === "") return body;
    if (body === "") return top;
    return `${top}\n${body}`;
  }

  protected override piece(p: unknown): Piece {
    if (p instanceof Code) return this.harvest(p);
    if (p instanceof Import) {
      this.record(p);
      return p.toCodeString();
    }
    if (looksLikeForeignPoet(p)) {
      // Two physical ts-poet copies in one process (a linked or global CLI next to a project
      // dependency): the fragment's imports cannot be read, so refuse rather than drop them.
      throw new WriterError(
        WRITER_ERRORS.unknownPiece,
        "a ts-poet Code or Import built by a different ts-poet copy; import code and imp from @metaobjectsdev/codegen-ts",
      );
    }
    return super.piece(p);
  }

  private harvest(fragment: Code): string {
    const todo: unknown[] = [fragment];
    for (let i = 0; i < todo.length; i++) {
      const n = todo[i];
      if (n instanceof Import) this.record(n);
      else if (n instanceof Node) todo.push(...n.childNodes);
      else if (Array.isArray(n)) todo.push(...n);
    }
    return fragment.toCodeString([]);
  }

  private record(i: Import): void {
    if (i instanceof ImportsName) this.addNamed(i.sourceSymbol ?? i.symbol, i.symbol, i.source, i.typeImport === true);
    else if (i instanceof ImportsDefault) this.useDefault(i.symbol, i.source);
    else if (i instanceof ImportsAll) this.useNamespace(i.symbol, i.source);
    else if (i instanceof SideEffect) this.useSideEffect(i.source);
    // An implicit import (`imp("Foo")` with no module) names a global and imports nothing.
  }

  private addNamed(exported: string, local: string, from: string, typeOnly: boolean): string {
    this.claim(local, from);
    const named = this.module(from).named;
    const seen = named.get(local);
    if (seen === undefined) named.set(local, { exported, typeOnly });
    else if (seen.exported !== exported) {
      throw new WriterError(WRITER_ERRORS.importConflict, `${local} from ${str(from)} names both ${seen.exported} and ${exported}`);
    } else seen.typeOnly &&= typeOnly;
    return local;
  }

  private claim(local: string, from: string): void {
    const owner = this.locals.get(local);
    if (owner !== undefined && owner !== from) {
      throw new WriterError(WRITER_ERRORS.importConflict, `${local} is imported from both ${str(owner)} and ${str(from)}`);
    }
    this.locals.set(local, from);
  }

  private module(from: string): ModuleImports {
    let m = this.modules.get(from);
    if (m === undefined) {
      m = { named: new Map(), namespaces: new Set(), sideEffect: false };
      this.modules.set(from, m);
    }
    return m;
  }

  private writeImport(w: CodeWriter, from: string, m: ModuleImports): void {
    const tail = ` from ${str(from)};`;
    for (const ns of [...m.namespaces].sort(byCodeUnit)) w.line(`import * as ${ns}${tail}`);
    const names = [...m.named].sort(([a], [b]) => byCodeUnit(a, b));
    const typeOnly = m.defaultName === undefined && names.length > 0 && names.every(([, n]) => n.typeOnly);
    const items = names.map(([local, n]) => {
      const spec = n.exported === local ? local : `${n.exported} as ${local}`;
      return n.typeOnly && !typeOnly ? `type ${spec}` : spec;
    });
    const lead = typeOnly ? "import type " : "import ";
    if (items.length > 0) {
      // One name never breaks: `import { X } from "a/long/module"` stays on one line.
      const braces: Piece = items.length === 1 ? `{ ${items[0]} }` : new Group("{", items, "}", true);
      w.line(lead, m.defaultName === undefined ? "" : `${m.defaultName}, `, braces, tail);
    } else if (m.defaultName !== undefined) {
      w.line(`import ${m.defaultName}${tail}`);
    } else if (m.namespaces.size === 0 && m.sideEffect) {
      w.line(`import ${str(from)};`);
    }
  }
}

function looksLikeForeignPoet(p: unknown): boolean {
  return typeof p === "object" && p !== null && "toCodeString" in p && "childNodes" in p;
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Package imports first, then relative ones; each group in code-unit order. */
function sortModules(modules: string[]): string[] {
  const relative = (m: string) => m.startsWith(".");
  return [...modules.filter((m) => !relative(m)).sort(byCodeUnit), ...modules.filter(relative).sort(byCodeUnit)];
}
