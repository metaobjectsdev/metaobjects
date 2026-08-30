/**
 * Snippet markers for HAND-AUTHORED files.
 *
 * A generated file cannot carry these — every regen rewrites it — so machine-owned
 * output uses the committed-excerpt + subsequence gate in ./subsequence.ts instead.
 * The rule: the excerpt is declared IN the file when the file is ours to edit, and
 * BESIDE it when it isn't. See the design doc, decision D3.
 */
const OPEN = /^\s*#\s*>>>\s*snippet:\s*(\S+)\s*$/;
const CLOSE = /^\s*#\s*<<<\s*$/;

export function extractMarkedRegion(source: string, id: string): string {
  const lines = source.split("\n");
  const start = lines.findIndex((l) => OPEN.exec(l)?.[1] === id);
  if (start === -1) throw new Error(`no marker "${id}" in source`);
  const end = lines.findIndex((l, i) => i > start && CLOSE.test(l));
  if (end === -1) throw new Error(`unterminated marker "${id}"`);

  const region = lines.slice(start + 1, end);
  // Blank lines carry no indent information; letting them count would collapse
  // every dedent to zero the moment a region contains one.
  const indents = region.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length);
  const common = indents.length ? Math.min(...indents) : 0;
  const body = region.map((l) => (l.trim() ? l.slice(common) : l));

  // Trim blank LINES, never whitespace: `.trim()` would strip the first line's
  // remaining indent whenever it is not the least-indented line, destroying the
  // relative structure the dedent exists to preserve.
  // Read through `?.` rather than a `.length` guard tsc cannot connect to the index:
  // on an empty array the access is `undefined`, which is not `""`, so the loop ends.
  while (body[0]?.trim() === "") body.shift();
  while (body[body.length - 1]?.trim() === "") body.pop();
  return body.join("\n");
}
