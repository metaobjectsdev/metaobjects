// server/typescript/packages/metadata/src/json-path.ts
//
// FR5a / ADR-0009 — Canonical JSONPath builder.
//
// Construction rules (cross-port-aligned):
//   - Root is `$`.
//   - Object keys matching /^[A-Za-z_][A-Za-z0-9_]*$/ use dot notation: `.foo`.
//   - All other keys use single-quoted bracket form: `['my-key']`, `['@attr']`.
//   - Array indices use bracket form: `[N]`.
//   - No trailing dots, no whitespace.

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

type Segment =
  | { kind: "key"; value: string }
  | { kind: "index"; value: number };

export class JsonPathBuilder {
  private readonly segments: Segment[] = [];

  pushKey(key: string): void {
    this.segments.push({ kind: "key", value: key });
  }

  pushIndex(idx: number): void {
    this.segments.push({ kind: "index", value: idx });
  }

  pop(): void {
    this.segments.pop();
  }

  toString(): string {
    let out = "$";
    for (const seg of this.segments) {
      if (seg.kind === "index") {
        out += `[${seg.value}]`;
      } else if (IDENT_RE.test(seg.value)) {
        out += `.${seg.value}`;
      } else {
        out += `['${seg.value.replace(/'/g, "\\'")}']`;
      }
    }
    return out;
  }
}
