// The language-neutral code writer (ADR-0063; contract: spec/code-writer.md).
//
// A generator says WHAT a line contains; the writer decides WHERE it sits. It builds the
// file in memory and returns a string, so nothing here touches the disk and no formatter
// ever runs over the result. It never parses the text it is handed: it lays out the
// structure the generator gave it — lines, blocks, blank-line requests and breakable lists.
//
// This module and the dialects beside it are the ONLY codegen source allowed to type
// layout (newlines, indentation). The layout ratchet test (test/layout-ratchet/) holds
// every other generator module to that.

/** Error codes a writer throws. Shared by every port's writer (spec/code-writer.md). */
export const WRITER_ERRORS = {
  /** `close()` with no block open. */
  unbalancedClose: "ERR_WRITER_UNBALANCED_CLOSE",
  /** The file was finished with a block still open; the message quotes the line that opened it. */
  unclosedBlock: "ERR_WRITER_UNCLOSED_BLOCK",
  /** `line()` was handed text containing a line break. */
  newlineInLine: "ERR_WRITER_NEWLINE_IN_LINE",
  /** One local name imported from two different places. */
  importConflict: "ERR_WRITER_IMPORT_CONFLICT",
  /** A piece the writer does not know how to print. */
  unknownPiece: "ERR_WRITER_UNKNOWN_PIECE",
} as const;
export type WriterErrorCode = (typeof WRITER_ERRORS)[keyof typeof WRITER_ERRORS];

export class WriterError extends Error {
  constructor(
    readonly code: WriterErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "WriterError";
  }
}

/**
 * A bracketed, comma-separated list. Printed on one line when the line fits the width;
 * otherwise opener, one item per line (each followed by a comma) and closer.
 */
export class Group {
  constructor(
    readonly open: string,
    readonly items: readonly Piece[],
    readonly close: string,
    /** `{ a, b }` (true) versus `[a, b]` or `f(a, b)` (false) when printed on one line. */
    readonly pad = false,
  ) {}
}

/** An expression fragment: text, a breakable list, or a concatenation of fragments. */
export type Piece = string | Group | readonly Piece[];

/** A list with no padding inside its brackets: `[a, b]`, `f(a, b)`, `<A, B>`. */
export const list = (open: string, items: readonly Piece[], close: string): Group => new Group(open, items, close);

export interface CodeWriterOptions {
  /** One level of indentation. Default two spaces. */
  readonly indent?: string;
  /** The column a line may reach before its last list breaks. Default 120. */
  readonly width?: number;
  /** Whether a broken list puts a comma after its last item too. Default true. */
  readonly trailingComma?: boolean;
}

const NEWLINE = "\n";
const ANY_LINE_BREAK = /\r\n?|\n/;

/** Character width of `s`, in Unicode code points. */
function widthOf(s: string): number {
  // A fast path: generated code is almost always ASCII, where length is the answer.
  return /^[\x00-\x7f]*$/.test(s) ? s.length : [...s].length;
}

/**
 * The core writer. Built to be extended (ADR-0063): every method is public or protected, so a
 * dialect or an adopter's subclass overrides the one step it needs to change, such as where a
 * line breaks (`breakAt`) or what a part becomes (`piece`). These methods are not a stability
 * contract and may change between minor versions.
 */
export class CodeWriter {
  readonly indent: string;
  readonly width: number;
  readonly trailingComma: boolean;

  protected readonly out: string[] = [];
  /** The text of each line that opened a block still open, outermost first. */
  protected readonly openers: string[] = [];
  protected readonly prefixes: string[] = [""];
  protected wantBlank = false;
  /** True at the start of the file and right after a block opens: no blank line goes here. */
  protected atBlockStart = true;

  constructor(options: CodeWriterOptions = {}) {
    this.indent = options.indent ?? "  ";
    this.width = options.width ?? 120;
    this.trailingComma = options.trailingComma ?? true;
  }

  /**
   * One line at the current indent. The parts are concatenated; when the line does not fit
   * the width, the LAST non-empty list in it is printed one item per line. A line whose
   * text is empty is a blank-line request.
   */
  line(...parts: readonly unknown[]): this {
    return this.put(this.piece(parts));
  }

  /** Ask for one blank line before whatever is written next. Requests never stack. */
  blank(): this {
    this.wantBlank = true;
    return this;
  }

  /** Write the line that opens a block, then indent. */
  open(...parts: readonly unknown[]): this {
    return this.openPiece(this.piece(parts));
  }

  /** Dedent, then write the line that closes the block. */
  close(...parts: readonly unknown[]): this {
    return this.closePiece(this.piece(parts));
  }

  /** `open(head)`, the body, then `close(tail)`: the indent cannot be left unbalanced. */
  block(head: unknown, body: () => void, tail: unknown = "}"): this {
    this.open(head);
    body();
    return this.close(tail);
  }

  /**
   * The body one level in, with no opening or closing line: a block delimited by indentation
   * alone, as a SQL clause list or a YAML mapping is.
   */
  indented(body: () => void): this {
    this.openers.push("");
    body();
    this.openers.pop();
    return this;
  }

  /**
   * A multi-line snippet written as it should read. Its common left margin is removed and
   * it is re-indented to the current level; a blank line in it is a blank-line request.
   * Every line is re-indented, including lines inside a multi-line string literal.
   */
  text(snippet: string): this {
    const lines = snippet.split(ANY_LINE_BREAK);
    if (lines.length > 1 && lines[0]!.trim() === "") lines.shift();
    if (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
    let margin = Number.POSITIVE_INFINITY;
    for (const l of lines) {
      if (l.trim() !== "") margin = Math.min(margin, l.length - l.trimStart().length);
    }
    for (const l of lines) {
      if (l.trim() === "") this.blank();
      else this.put(l.slice(margin));
    }
    return this;
  }

  /** The body text: every line joined, with no final newline. Throws if a block is still open. */
  protected body(): string {
    if (this.openers.length > 0) {
      throw new WriterError(WRITER_ERRORS.unclosedBlock, `unclosed block opened by: ${this.openers[this.openers.length - 1]!}`);
    }
    return this.out.join(NEWLINE);
  }

  /** The finished file: `\n` line endings, no trailing whitespace, one final newline (none when empty). */
  toString(): string {
    const body = this.body();
    return body === "" ? "" : body + NEWLINE;
  }

  /**
   * Turn one argument of `line()` into a writer piece. A dialect overrides this to accept
   * its own fragment types (TsWriter accepts ts-poet `Code`), and calls `super` for the rest.
   */
  protected piece(p: unknown): Piece {
    if (typeof p === "string") return p;
    if (p instanceof Group) {
      const items = p.items.map((i) => this.piece(i));
      return items.every((i, n) => i === p.items[n]) ? p : new Group(p.open, items, p.close, p.pad);
    }
    if (Array.isArray(p)) return p.map((x) => this.piece(x));
    throw new WriterError(WRITER_ERRORS.unknownPiece, `cannot write ${describe(p)}`);
  }

  /** Whether `text` fits on one line at the current indent. */
  protected fits(text: string): boolean {
    return widthOf(this.prefix()) + widthOf(text) <= this.width;
  }

  /**
   * Where a line that does not fit breaks: [text before, the list that breaks, text after], or
   * undefined to print the line as it is. The default is the line's LAST non-empty list.
   */
  protected breakAt(piece: Piece): [string, Group, string] | undefined {
    return lastGroup(piece);
  }

  protected openPiece(piece: Piece): this {
    this.put(piece);
    this.openers.push(flat(piece).trim());
    this.atBlockStart = true;
    return this;
  }

  protected closePiece(piece: Piece): this {
    if (this.openers.length === 0) {
      throw new WriterError(WRITER_ERRORS.unbalancedClose, `close(${JSON.stringify(flat(piece))}) with no block open`);
    }
    this.openers.pop();
    this.wantBlank = false;
    return this.put(piece);
  }

  protected prefix(): string {
    const depth = this.openers.length;
    while (this.prefixes.length <= depth) this.prefixes.push(this.prefixes[this.prefixes.length - 1]! + this.indent);
    return this.prefixes[depth]!;
  }

  protected put(piece: Piece): this {
    const raw = flat(piece);
    if (ANY_LINE_BREAK.test(raw)) {
      throw new WriterError(
        WRITER_ERRORS.newlineInLine,
        `line text contains a line break; write each line separately or use text(): ${JSON.stringify(raw)}`,
      );
    }
    const text = raw.trimEnd();
    if (text === "") return this.blank();
    if (this.wantBlank && !this.atBlockStart) this.out.push("");
    this.wantBlank = false;
    this.atBlockStart = false;
    const pre = this.prefix();
    const split = this.fits(text) ? undefined : this.breakAt(piece);
    if (split === undefined) {
      this.out.push(pre + text);
      return this;
    }
    const [before, group, after] = split;
    this.openPiece(before + group.open);
    group.items.forEach((item, n) => {
      const comma = n < group.items.length - 1 || this.trailingComma ? "," : "";
      this.put([item, comma]);
    });
    return this.closePiece(group.close + after);
  }
}

/** A piece printed on one line. */
export function flat(p: Piece): string {
  if (typeof p === "string") return p;
  if (p instanceof Group) {
    if (p.items.length === 0) return p.open + p.close;
    const inner = p.items.map(flat).join(", ");
    return p.pad ? `${p.open} ${inner} ${p.close}` : p.open + inner + p.close;
  }
  let s = "";
  for (const x of p) s += flat(x);
  return s;
}

/** Split a piece around its LAST non-empty list: [text before, the list, text after]. */
function lastGroup(p: Piece): [string, Group, string] | undefined {
  if (typeof p === "string") return undefined;
  if (p instanceof Group) return p.items.length === 0 ? undefined : ["", p, ""];
  for (let i = p.length - 1; i >= 0; i--) {
    const hit = lastGroup(p[i]!);
    if (hit !== undefined) {
      return [flat(p.slice(0, i)) + hit[0], hit[1], hit[2] + flat(p.slice(i + 1))];
    }
  }
  return undefined;
}

function describe(p: unknown): string {
  if (p === null || p === undefined) return String(p);
  if (typeof p === "object") return `an object (${p.constructor?.name ?? "no constructor"})`;
  return `a ${typeof p}`;
}
