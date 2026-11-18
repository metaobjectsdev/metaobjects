// Warm-load driver for the TypeScript loader.
// usage: node ts-load.mjs <model-dir> <timed-loads> [--canonical <out-file>]
// env:   MO_TS_DIST  the metadata package's built dist/ (default: this checkout's)
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

const dist = process.env.MO_TS_DIST ?? path.resolve(import.meta.dirname, "../../server/typescript/packages/metadata/dist");
const { MetaDataLoader, canonicalSerialize } = await import(pathToFileURL(path.join(dist, "index.js")).href);

const [dir, n = "7", ...rest] = process.argv.slice(2);
const canonicalOut = rest[0] === "--canonical" ? rest[1] : undefined;

const load = async () => {
  const r = await MetaDataLoader.fromDirectory(dir);
  if (r.errors.length > 0) throw new Error(`load errors: ${r.errors[0]}`);
  return r;
};

const first = await load(); // warm-up
if (canonicalOut) writeFileSync(canonicalOut, canonicalSerialize(first.root));
const times = [];
for (let i = 0; i < Number(n); i++) {
  const t0 = performance.now();
  await load();
  times.push(performance.now() - t0);
}
times.sort((a, b) => a - b);
console.log(JSON.stringify({ port: "typescript", loads: times.length, median_ms: +times[times.length >> 1].toFixed(1), peak_rss_mib: +(process.resourceUsage().maxRSS / 1024).toFixed(0) }));
