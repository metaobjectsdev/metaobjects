// Oracle for the differential test: evaluates each case with the real JS RegExp.
// Input: path to a JSON-lines file of {"id","src","global","input"}.
// Output (stdout): one JSON line per case: [id, [match, ...]] where a match is
// an array of [start,end] code-point offsets (or null for a missing group),
// group 0 first.

import fs from "node:fs";
const cases = fs.readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean);
const cache = new Map();
const out = [];
for (const line of cases) {
  const c = JSON.parse(line);
  const key = (c.global ? "g:" : "n:") + c.src;
  let re = cache.get(key);
  if (!re) {
    // The `d` flag only adds group indices; it does not change matching.
    re = new RegExp(c.src, c.global ? "gd" : "d");
    cache.set(key, re);
  }
  const s = c.input;
  const map = new Array(s.length + 1);
  let cp = 0;
  for (let i = 0; i < s.length; ) {
    const w = s.codePointAt(i) > 0xffff ? 2 : 1;
    for (let k = 0; k < w; k++) map[i + k] = cp;
    i += w;
    cp++;
  }
  map[s.length] = cp;
  re.lastIndex = 0;
  const found = c.global ? Array.from(s.matchAll(re)) : [re.exec(s)].filter((m) => m !== null);
  const matches = found.map((m) =>
    Array.from(m.indices, (ix) => (ix === undefined ? null : [map[ix[0]], map[ix[1]]])),
  );
  out.push(JSON.stringify([c.id, matches]));
}
process.stdout.write(out.join("\n") + "\n");
