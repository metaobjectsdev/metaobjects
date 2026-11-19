// Seeded generator of SYNTHETIC markdown backlogs. Nothing here is copied from a real backlog:
// every id, title and tag is built from the small vocabularies below. The same seed always
// gives the same file, so a failing seed is a reproducer.

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
const chance = (r: Rng, p: number): boolean => r() < p;
const int = (r: Rng, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));

const WORDS = [
  "adopt", "lease", "widget", "rewrite", "service", "cache", "index", "parser", "gateway", "queue",
  "migrate", "audit", "retry", "backoff", "schema", "router", "metrics", "flaky", "test", "cleanup",
  "café", "naïve", "日本語", "Ünïcode", "ß", "Ω", "résumé", "tab\there", "quote\"s", "comma,s", "colon: here",
  "\u001b[0m", "100%", "a#b", "[bracket]", "{brace}", "-dash", "true", "null", "42", "3.14", "  spaced  ",
];
const REPOS = ["widgets", "svc", "docs-site", "infra", "a/b", "repo with space", "x:y", "é-repo", "7", "true"];
const KINDS = ["task", "scout", "ship", "docs", "secondmate", "chore", "kind with space", "a,b"];
const HOLD_KINDS = ["captain", "external", "load", "parked", "future"];
const LEADING = ["SHIP", "SCOUT", "DOCS-ONLY", "PERSISTENT SECONDMATE", "SHIPPING", "SCOUTS", "ship"];
const PAST = ["2000-01-01", "2001-06-15", "2010-12-31"];
const FUTURE = ["2999-12-31", "2500-01-01", "3000-06-15"];
const ANY_DATE = ["2026-09-30", "2026-10-01", "2026-10-02", "2025-01-01", "2024-02-29"];
const URLS = [
  "https://github.com/o/r/pull/42",
  "https://github.com/o/r/pull/7).",
  "https://github.com/o/r/issues/9",
  "https://git.example.org/o/r/pulls/12",
  "https://github.com/o/r/pulls/3",
  "https://github.com/o/r/pull/042",
  "https://example.com/docs/page?x=1,2;",
  "http://plain.example.net/a/b.",
  "data/some-task/report.md",
  "see data/other-x1/report.md.",
];

function word(r: Rng): string {
  return pick(r, WORDS);
}
function sentence(r: Rng, n: number): string {
  return Array.from({ length: n }, () => word(r)).join(" ");
}

function slug(r: Rng, used: string[]): string {
  if (used.length > 0 && chance(r, 0.04)) return pick(r, used); // duplicate id
  const heads = ["alpha", "beta", "gamma", "fm-x", "sm-idle", "Homemux", "a.b", "x_y", "k9", "Z", "t"];
  return `${pick(r, heads)}-${Math.floor(r() * 1296).toString(36).padStart(2, "0")}${chance(r, 0.1) ? "." + int(r, 1, 9) : ""}`;
}

/** A title of exactly `len` UTF-16 units, with an astral character straddling the cut when asked. */
function boundaryText(r: Rng, len: number, astralAt: number | null): string {
  let s = "";
  while (s.length < len) s += word(r).replace(/[()]/g, "") + " ";
  s = s.slice(0, len);
  if (astralAt !== null && astralAt + 2 <= s.length) s = s.slice(0, astralAt) + "😀" + s.slice(astralAt + 2);
  return s.replace(/\s+$/, "x");
}

function title(r: Rng): string {
  const mode = int(r, 0, 9);
  if (mode === 0) return boundaryText(r, int(r, 76, 84), pick(r, [null, 78, 79, 80]));
  if (mode === 1) return boundaryText(r, int(r, 150, 300), null);
  const lead = chance(r, 0.2) ? pick(r, LEADING) + " " : "";
  let t = lead + sentence(r, int(r, 1, 9));
  if (chance(r, 0.15)) t += ` (reported ${pick(r, ANY_DATE)}): ${word(r)}`; // mid-sentence parenthetical
  if (chance(r, 0.15)) t += " " + pick(r, URLS);
  if (chance(r, 0.05)) t += " 😀🙂";
  return t;
}

function tags(r: Rng, state: string, ids: string[]): string {
  const parts: string[] = [];
  if (chance(r, 0.35)) parts.push(`(repo: ${chance(r, 0.04) ? "  " : pick(r, REPOS)})`);
  if (chance(r, 0.2)) parts.push(`(kind: ${chance(r, 0.04) ? "  " : pick(r, KINDS)})`);
  if (chance(r, 0.3)) parts.push(`(priority: ${int(r, 0, 4)})`);
  if (chance(r, 0.05)) parts.push(`(priority: 9)`);
  if (chance(r, 0.35)) parts.push(`(since ${pick(r, ANY_DATE)})`);
  if (state === "done" && chance(r, 0.7)) parts.push(`(${pick(r, ["merged", "reported", "done", "closed"])} ${pick(r, ANY_DATE)})`);
  if (chance(r, 0.2)) {
    parts.push(`(hold: ${chance(r, 0.04) ? " " : sentence(r, int(r, 1, 3))})`);
    if (chance(r, 0.7)) parts.push(`(hold-kind: ${pick(r, HOLD_KINDS)})`);
    if (chance(r, 0.8)) parts.push(`(hold-until: ${pick(r, [...PAST, ...FUTURE])})`);
  } else {
    if (chance(r, 0.04)) parts.push(`(hold-kind: ${pick(r, HOLD_KINDS)})`);
    if (chance(r, 0.04)) parts.push(`(hold-until: ${pick(r, FUTURE)})`);
  }
  // shuffle the order, since tail parsing is order-sensitive
  for (let i = parts.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [parts[i], parts[j]] = [parts[j] as string, parts[i] as string];
  }
  const deps: string[] = [];
  const nDeps = chance(r, 0.35) ? int(r, 1, 3) : 0;
  for (let i = 0; i < nDeps; i++) {
    const type = pick(r, ["blocked-by", "blocked-by", "parent", "discovered-from"]);
    const target = ids.length > 0 && chance(r, 0.8) ? pick(r, ids) : `ghost-${int(r, 1, 9)}x`;
    const reason = chance(r, 0.3) ? ` - ${sentence(r, int(r, 1, 4))}` : "";
    deps.push(`${type}: ${target}${reason}`);
  }
  const bare = deps.filter((d) => !d.includes(" - "));
  const reasoned = deps.filter((d) => d.includes(" - "));
  const space = chance(r, 0.05) ? "  " : " ";
  return [...bare, ...parts, ...reasoned.slice(-1)].map((p) => space + p).join("");
}

// Body lines whose first or last character exercises string quoting in the printed output.
const STRANGE_BODY = [
  "## Heading", "#hash", "+1", "05", "1e5", "-3", "1.5E+3", "0", "1.", ".5", "0x10", "true", "null", "NaN",
  "\u00a0nbsp-lead", "nbsp-trail\u00a0", "\ufeffbom-lead", "\u2003em-space", "\u0085next-line", "- dash", "key: value",
  "\u001b[0m", "\u0001ctl", "ctl\u001f", "a,b", "x\ty", "\"quoted\"", "back\\slash", "[1]", "{x}", "trail ", " lead",
];

function body(r: Rng): string[] {
  if (!chance(r, 0.4)) return [];
  const lines: string[] = [];
  const n = int(r, 1, 6);
  for (let i = 0; i < n; i++) {
    const k = int(r, 0, 9);
    if (k === 0) lines.push("");
    else if (k === 1) lines.push("  ## Intent");
    else if (k === 2) lines.push("   extra-indented " + word(r));
    else if (k === 3) lines.push("  " + boundaryText(r, int(r, 495, 506), pick(r, [null, 498, 499, 500])));
    else if (k === 4) lines.push("  " + pick(r, STRANGE_BODY));
    else lines.push("  " + sentence(r, int(r, 2, 12)));
  }
  if (chance(r, 0.3)) lines.push("", "");
  return lines;
}

export interface BacklogOptions {
  seed: number;
  crlf?: boolean;
}

export function syntheticBacklog(opts: BacklogOptions): string {
  const r = mulberry32(opts.seed);
  const out: string[] = ["# Backlog", ""];
  if (chance(r, 0.5)) out.push("Free-form preamble. - [ ] not-a-task - preamble bullet", "");
  const ids: string[] = [];
  const sections: [string, string][] = [
    ["## In flight", "in_flight"],
    ["## Queued", "queued"],
    ["## Done (retained)", "done"],
  ];
  if (chance(r, 0.3)) sections.splice(int(r, 0, 3), 0, ["## Notes", "none"]);
  if (chance(r, 0.15)) sections.push(["##   Queued  ", "queued"]);
  if (chance(r, 0.1)) sections.push(["## DONE", "done"]);
  for (const [header, state] of sections) {
    out.push(header, "");
    const n = chance(r, 0.15) ? 0 : int(r, 1, 7);
    for (let i = 0; i < n; i++) {
      const id = slug(r, ids);
      ids.push(id);
      const prose = title(r) + tags(r, state, ids.slice(0, -1));
      let bullet: string;
      if (state === "done") bullet = `- [x] ${id} - ${prose}`;
      else if (state === "in_flight" && chance(r, 0.3)) bullet = `- **${id}** - ${prose}`;
      else bullet = `- [ ] ${id} - ${prose}`;
      out.push(bullet, ...body(r));
      if (chance(r, 0.3)) out.push("");
    }
  }
  if (chance(r, 0.1)) out.push("- [ ] stray-after-sections - stray bullet");
  let text = out.join("\n");
  if (!chance(r, 0.1)) text += "\n";
  if (opts.crlf ?? chance(r, 0.15)) text = text.replace(/\n/g, "\r\n");
  return text;
}

/** The task ids written in a backlog's text (any section), for choosing `show` targets. */
export function idsIn(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^- (?:\[[ x]\] |\*\*)([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line);
    if (m) found.push(m[1] as string);
  }
  return found;
}
