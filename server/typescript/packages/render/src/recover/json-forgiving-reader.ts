// Stage-4 tolerant JSON reader for the bounded corpus malformation set. Never throws.
// Mirrors Java JsonForgivingReader. The no-hang + TRUNCATED contracts are load-bearing.

/** Sentinel: a key appeared in the text but its value was empty/cut-off (present-but-garbled). */
export const TRUNCATED: unique symbol = Symbol("recover.json.TRUNCATED");

/** A character is JSON-insignificant whitespace. Mirrors Java Character.isWhitespace closely enough for the corpus. */
function isWhitespace(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v" || /\s/.test(c);
}

function isLetterOrDigitOrUnderscore(c: string): boolean {
  return /[A-Za-z0-9_]/.test(c);
}

class Reader {
  private s = "";
  private i = 0;

  read(span: string | null | undefined): Record<string, unknown> {
    this.s = span ?? "";
    this.i = 0;
    this.ws();
    if (this.i >= this.s.length || this.s.charAt(this.i) !== "{") return {};
    const o = this.readValue();
    return isPlainObject(o) ? (o as Record<string, unknown>) : {};
  }

  private readValue(): unknown {
    this.ws();
    if (this.i >= this.s.length) return null;
    const c = this.s.charAt(this.i);
    if (c === "{") return this.readObject();
    if (c === "[") return this.readArray();
    if (c === '"' || c === "'") return this.readString(c);
    return this.readBareScalar();
  }

  private readObject(): Record<string, unknown> {
    const m: Record<string, unknown> = {};
    this.i++; // consume '{'
    for (;;) {
      this.ws();
      if (this.i >= this.s.length) return m; // truncation
      if (this.s.charAt(this.i) === "}") {
        this.i++;
        return m;
      }
      const key = this.readKey();
      if (key === null) return m; // truncation mid-key
      this.ws();
      if (this.i >= this.s.length || this.s.charAt(this.i) !== ":") return m; // truncation before value
      this.i++; // consume ':'
      this.ws();
      if (this.i >= this.s.length) {
        m[key] = TRUNCATED; // value cut off at EOF → present-but-garbled
        return m;
      }
      const v = this.readValue();
      if (v === null) {
        // present key, empty/zero-width value → present-but-garbled
        m[key] = TRUNCATED;
        this.ws();
        if (this.i < this.s.length && this.s.charAt(this.i) === ",") {
          this.i++;
          continue;
        }
        if (this.i < this.s.length && this.s.charAt(this.i) === "}") this.i++;
        return m;
      }
      m[key] = v;
      this.ws();
      if (this.i < this.s.length && this.s.charAt(this.i) === ",") this.i++; // optional/trailing comma
    }
  }

  private readArray(): unknown[] {
    const xs: unknown[] = [];
    this.i++; // consume '['
    for (;;) {
      this.ws();
      if (this.i >= this.s.length) return xs;
      if (this.s.charAt(this.i) === "]") {
        this.i++;
        return xs;
      }
      if (this.s.charAt(this.i) === "}") {
        this.i++;
        return xs;
      } // malformed brace-close terminates array
      const v = this.readValue();
      if (v === null) {
        // zero-width / no value → stop (no spin)
        this.ws();
        if (this.i < this.s.length && (this.s.charAt(this.i) === "]" || this.s.charAt(this.i) === "}")) this.i++;
        return xs;
      }
      xs.push(v);
      this.ws();
      if (this.i < this.s.length && this.s.charAt(this.i) === ",") this.i++;
      else if (this.i < this.s.length && this.s.charAt(this.i) === "]") {
        this.i++;
        return xs;
      } else if (this.i >= this.s.length) return xs;
      else return xs; // any other non-separator char → stop
    }
  }

  private readKey(): string | null {
    this.ws();
    if (this.i >= this.s.length) return null;
    const c = this.s.charAt(this.i);
    if (c === '"' || c === "'") return this.readString(c);
    const start = this.i;
    while (this.i < this.s.length && isLetterOrDigitOrUnderscore(this.s.charAt(this.i))) this.i++;
    return this.i > start ? this.s.substring(start, this.i) : null;
  }

  private readString(quoteChar: string): string {
    this.i++; // opening quote
    let sb = "";
    let esc = false;
    while (this.i < this.s.length) {
      const c = this.s.charAt(this.i++);
      if (esc) {
        sb += unescape(c);
        esc = false;
      } else if (c === "\\") esc = true;
      else if (c === quoteChar) return sb;
      else sb += c;
    }
    return sb; // unterminated string → return what we have
  }

  private readBareScalar(): string | null {
    const start = this.i;
    while (this.i < this.s.length && ",}]".indexOf(this.s.charAt(this.i)) < 0) this.i++;
    const result = this.s.substring(start, this.i).trim();
    return result.length === 0 ? null : result; // null = no token read (zero-width)
  }

  private ws(): void {
    while (this.i < this.s.length && isWhitespace(this.s.charAt(this.i))) this.i++;
  }
}

function unescape(c: string): string {
  switch (c) {
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    default:
      return c;
  }
}

function isPlainObject(o: unknown): boolean {
  return typeof o === "object" && o !== null && !Array.isArray(o);
}

/** Parse a tolerant JSON object span into a forgiving record. Never throws. */
export function readJson(span: string | null | undefined): Record<string, unknown> {
  return new Reader().read(span);
}
