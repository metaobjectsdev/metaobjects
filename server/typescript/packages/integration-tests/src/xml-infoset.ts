// xml-infoset.ts — a small XML reader for the api-contract runner's `body.xml` assertion.
//
// The contract compares an export body as an XML infoset: element names, attributes, text and
// order. The XML declaration, comments and whitespace between elements are not significant, and
// a self-closing element equals an empty one. The writers under test emit a plain subset
// (elements, attributes, text, the five predefined entities and numeric references), which is all
// this reads; anything else throws rather than being guessed at.

export interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  /** Child elements and text runs, in document order. */
  children: Array<XmlElement | string>;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(raw: string): string {
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, ref: string) => {
    if (ref.startsWith("#x")) return String.fromCodePoint(parseInt(ref.slice(2), 16));
    if (ref.startsWith("#")) return String.fromCodePoint(parseInt(ref.slice(1), 10));
    const v = ENTITIES[ref];
    if (v === undefined) throw new Error(`xml: unknown entity ${whole}`);
    return v;
  });
}

/** Parse a document into its root element. */
export function parseXml(text: string): XmlElement {
  let i = 0;
  const skipMisc = (): void => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i]!)) i++;
      if (text.startsWith("<?", i)) i = text.indexOf("?>", i) + 2;
      else if (text.startsWith("<!--", i)) i = text.indexOf("-->", i) + 3;
      else return;
    }
  };
  const readName = (): string => {
    const m = /^[A-Za-z_][\w.:-]*/.exec(text.slice(i));
    if (!m) throw new Error(`xml: expected a name at offset ${i}`);
    i += m[0].length;
    return m[0];
  };
  const readElement = (): XmlElement => {
    if (text[i] !== "<") throw new Error(`xml: expected '<' at offset ${i}`);
    i++;
    const el: XmlElement = { name: readName(), attributes: {}, children: [] };
    for (;;) {
      while (/\s/.test(text[i] ?? "")) i++;
      if (text.startsWith("/>", i)) { i += 2; return el; }
      if (text[i] === ">") { i++; break; }
      const attr = readName();
      if (text[i] !== "=") throw new Error(`xml: expected '=' after ${attr}`);
      const quote = text[i + 1];
      if (quote !== '"' && quote !== "'") throw new Error(`xml: unquoted attribute ${attr}`);
      const end = text.indexOf(quote, i + 2);
      el.attributes[attr] = decode(text.slice(i + 2, end));
      i = end + 1;
    }
    for (;;) {
      if (text.startsWith("</", i)) {
        i += 2;
        const close = readName();
        if (close !== el.name) throw new Error(`xml: </${close}> closes <${el.name}>`);
        while (/\s/.test(text[i] ?? "")) i++;
        i++; // '>'
        return el;
      }
      if (text.startsWith("<!--", i)) { i = text.indexOf("-->", i) + 3; continue; }
      if (text[i] === "<") { el.children.push(readElement()); continue; }
      const next = text.indexOf("<", i);
      if (next < 0) throw new Error(`xml: <${el.name}> is never closed`);
      el.children.push(decode(text.slice(i, next)));
      i = next;
    }
  };
  skipMisc();
  const root = readElement();
  skipMisc();
  if (i < text.length) throw new Error(`xml: content after the root element at offset ${i}`);
  return root;
}

/** Normal form: whitespace-only text next to elements dropped, adjacent text merged, attributes sorted. */
function normalize(el: XmlElement): unknown {
  const hasElements = el.children.some((c) => typeof c !== "string");
  const kids: unknown[] = [];
  let run = "";
  const flush = (): void => {
    if (run !== "" && !(hasElements && run.trim() === "")) kids.push(run);
    run = "";
  };
  for (const c of el.children) {
    if (typeof c === "string") run += c;
    else { flush(); kids.push(normalize(c)); }
  }
  flush();
  return {
    name: el.name,
    attributes: Object.fromEntries(Object.entries(el.attributes).sort(([a], [b]) => (a < b ? -1 : 1))),
    children: kids,
  };
}

/** Whether two documents are the same XML infoset; throws a readable parse error for malformed input. */
export function xmlInfosetEqual(actual: string, expected: string): boolean {
  return JSON.stringify(normalize(parseXml(actual))) === JSON.stringify(normalize(parseXml(expected)));
}
