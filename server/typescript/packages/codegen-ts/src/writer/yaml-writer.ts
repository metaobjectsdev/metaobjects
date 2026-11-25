// The YAML dialect of the code writer (ADR-0063; contract: spec/code-writer.md).
//
// YAML blocks are delimited by indentation alone: a `key:` line opens one and nothing closes
// it, and a block-list entry carries `- ` on its first line with the rest aligned under it.
// The writer keeps both: `key()` writes the line and indents the body (`indented()`), `item()` puts
// the dash on the entry's first line. Nothing breaks a line: a flow list is written as the
// generator gives it, so the width is unbounded.

import { CodeWriter, type CodeWriterOptions, type Piece } from "./code-writer.js";

const DASH = "- ";

export interface YamlWriterOptions extends Omit<CodeWriterOptions, "trailingComma"> {}

export class YamlWriter extends CodeWriter {
  /** The next line written is the first line of a block-list entry, and carries the dash. */
  protected dashNext = false;

  constructor(options: YamlWriterOptions = {}) {
    super({ indent: "  ", width: Number.POSITIVE_INFINITY, ...options, trailingComma: false });
  }

  /** `key:` and the block under it, indented, with no closing line. */
  key(name: string, body: () => void): this {
    return this.line(`${name}:`).indented(body);
  }

  /** One block-list entry: the first line `body` writes carries the `- `, the rest align under it. */
  item(body: () => void): this {
    this.openers.push(DASH);
    this.dashNext = true;
    body();
    this.dashNext = false;
    this.openers.pop();
    return this;
  }

  /** The entry's first line goes one level up, after the dash. */
  protected override put(piece: Piece): this {
    if (!this.dashNext) return super.put(piece);
    this.dashNext = false;
    const opener = this.openers.pop()!;
    super.put([DASH, piece]);
    this.openers.push(opener);
    return this;
  }
}
