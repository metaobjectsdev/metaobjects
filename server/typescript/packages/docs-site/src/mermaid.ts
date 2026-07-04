export interface ErEdge { parent: string; child: string; label: string; cardinality?: "one" | "many" | undefined; }

// base theme is the only theme that honors custom themeVariables; the built-in `dark`
// theme renders attribute-bearing ERDs unreadably. Surfaces match the site's dark palette.
export const THEME_INIT =
  `%%{init: {'theme':'base','themeVariables':{'darkMode':true,'background':'#0b1220',` +
  `'primaryColor':'#1e2a3a','primaryTextColor':'#cbd5e1','primaryBorderColor':'#4a7fa5',` +
  `'lineColor':'#64748b','secondaryColor':'#1a2535','tertiaryColor':'#0f1826',` +
  `'fontSize':'13px'}}}%%\n`;

const safe = (s: string) => s.replace(/"/g, "'");
const nodeId = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, "_");
const edgeSort = (a: ErEdge, b: ErEdge) =>
  a.parent.localeCompare(b.parent) || a.child.localeCompare(b.child) || a.label.localeCompare(b.label);

export function packageFlowchart(edges: { from: string; to: string; n: number }[], counts: Map<string, number>): string {
  const lines = [THEME_INIT + "flowchart LR"];
  const used = new Set(edges.flatMap((e) => [e.from, e.to]));
  for (const p of [...used].sort()) lines.push(`  ${p}["${safe(p)} · ${counts.get(p) ?? 0}"]`);
  for (const e of [...edges].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)))
    lines.push(`  ${e.from} -->|${e.n}| ${e.to}`);
  return lines.join("\n");
}

export function inheritanceTree(rows: { name: string; level: number; self?: boolean }[]): string {
  const lines = [THEME_INIT + "flowchart TD"];
  const ordered = [...rows].sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
  for (const r of ordered) lines.push(`  ${nodeId(r.name)}["${safe(r.name)}"]${r.self ? ":::self" : ""}`);
  // connect each node to the alphabetically-first node one level below it whose ancestor it is:
  // for a simple chain+children, link consecutive levels deterministically.
  const byLevel = new Map<number, string[]>();
  for (const r of ordered) (byLevel.get(r.level) ?? byLevel.set(r.level, []).get(r.level)!).push(nodeId(r.name));
  const levels = [...byLevel.keys()].sort((a, b) => a - b);
  for (let i = 1; i < levels.length; i++) {
    const parents = byLevel.get(levels[i - 1]!)!;
    const parent = parents[parents.length - 1]; // the chain node at the shallower level
    for (const child of byLevel.get(levels[i]!)!.sort()) lines.push(`  ${parent} --> ${child}`);
  }
  lines.push("  classDef self fill:#1e3a5f,stroke:#60a5fa,color:#e2e8f0,font-weight:bold");
  return lines.join("\n");
}

// ---- v2 diagram system: domain palette + rich/simple emitters ----
export const RICH_MAX = 8;
const ROLE_STROKE: Record<string, string> = { focal: "#60a5fa", view: "#2dd4bf", external: "#334155", normal: "#3b5170" };
const CURATED: Record<string, { fill: string; stroke: string; text: string }> = {
  session: { fill: "#1e3a5f", stroke: "#60a5fa", text: "#93c5fd" },
  npc:     { fill: "#3b2f1e", stroke: "#fbbf24", text: "#fde68a" },
  player:  { fill: "#3f2d5c", stroke: "#a78bfa", text: "#ede9fe" },
  arc:     { fill: "#3f1f2e", stroke: "#fb7185", text: "#fecdd3" },
  world:   { fill: "#14342b", stroke: "#34d399", text: "#a7f3d0" },
  engine_misc: { fill: "#1f2937", stroke: "#94a3b8", text: "#e2e8f0" },
  memory:  { fill: "#2a2440", stroke: "#818cf8", text: "#e0e7ff" },
  turn:    { fill: "#1a2e35", stroke: "#22d3ee", text: "#cffafe" },
  realm:   { fill: "#332018", stroke: "#fb923c", text: "#fed7aa" },
  common:  { fill: "#1c2431", stroke: "#64748b", text: "#cbd5e1" },
};
const PALETTE: { fill: string; stroke: string; text: string }[] = Object.values(CURATED);
export function domainColor(pkg: string): { fill: string; stroke: string; text: string } {
  const leaf = pkg.split("::").pop() ?? pkg;
  if (CURATED[leaf]) return CURATED[leaf];
  // stable slot for unmapped packages: hash the leaf name deterministically into the palette
  let h = 0; for (let i = 0; i < leaf.length; i++) h = (h * 31 + leaf.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}
const cls = (pkg: string) => `d_${(pkg.split("::").pop() ?? pkg).replace(/[^a-zA-Z0-9]/g, "_")}`;

export interface ErAttr { type: string; name: string; key: "PK" | "FK" | "UK" | ""; note: string; }
export interface ErNode { name: string; pkg: string; role: "focal" | "view" | "external" | "normal"; kind?: string; attrs: ErAttr[]; more: number; }
// erDiagram can't vary box shape, so KIND is encoded as a border dash + a glyph prefix in the box title.
const KIND_DASH: Record<string, string> = { value: ",stroke-dasharray:5 3", projection: ",stroke-dasharray:2 2" };
const KIND_GLYPH: Record<string, string> = { entity: "▭", value: "⬭", projection: "▱" };
const kindGlyph = (kind?: string) => KIND_GLYPH[kind ?? ""] ?? "▭";

export function erDiagramRich(nodes: ErNode[], edges: ErEdge[]): string {
  const lines = [THEME_INIT + "erDiagram"];
  for (const n of [...nodes].sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`  ${nodeId(n.name)}["${kindGlyph(n.kind)} ${safe(n.name)}"] {`);
    for (const a of n.attrs) {
      const keyPart = a.key ? ` ${a.key}` : "";
      lines.push(`    ${a.type} ${a.name}${keyPart} "${safe(a.note)}"`);
    }
    if (n.more > 0) lines.push(`    _ plus "+${n.more} more"`);
    lines.push("  }");
  }
  for (const e of [...edges].sort(edgeSort)) {
    const conn = e.cardinality === "many" ? "}o--o{" : "||--o{";
    lines.push(`  ${nodeId(e.parent)} ${conn} ${nodeId(e.child)} : "${safe(e.label)}"`);
  }
  // one classDef per entity: fill = domain, stroke = role
  for (const n of [...nodes].sort((a, b) => a.name.localeCompare(b.name))) {
    const dc = domainColor(n.pkg);
    lines.push(`  ${nodeId(n.name)}:::c_${nodeId(n.name)}`);
    lines.push(`  classDef c_${nodeId(n.name)} fill:${dc.fill},stroke:${ROLE_STROKE[n.role]},color:#cbd5e1${KIND_DASH[n.kind ?? ""] ?? ""}`);
  }
  return lines.join("\n");
}

// node shape encodes object KIND: entity = rectangle, value object = stadium (rounded ends),
// projection/view = parallelogram. Domain is the fill color; kind is the silhouette.
function shapeDecl(id: string, label: string, kind?: string): string {
  const l = `"${label}"`;
  if (kind === "value") return `${id}([${l}])`;
  if (kind === "projection") return `${id}[/${l}/]`;
  return `${id}[${l}]`; // entity / default
}

export function flowchartDomain(
  nodes: { name: string; pkg: string; kind?: string }[],
  edges: { from: string; to: string; label?: string; style?: "dashed" | undefined }[],
): { mermaid: string; legend: { pkg: string; fill: string; stroke: string }[] } {
  const lines = [THEME_INIT + "flowchart LR"];
  const kindByName = new Map(nodes.map((n) => [n.name, n.kind]));
  // collect all node names (from node list + edge endpoints), deduplicate, declare with explicit labels
  const allNodeNames = new Set<string>([
    ...nodes.map((n) => n.name),
    ...edges.flatMap((e) => [e.from, e.to]),
  ]);
  for (const name of [...allNodeNames].sort()) lines.push(`  ${shapeDecl(nodeId(name), safe(name), kindByName.get(name))}`);
  // edge labels must not contain flowchart-breaking chars (parens, pipes, brackets, braces)
  const edgeLabel = (s: string) => s.replace(/["|(){}\[\]]/g, "").replace(/\s+/g, " ").trim();
  for (const e of [...edges].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))) {
    const lbl = e.label ? edgeLabel(e.label) : "";
    const arrow = e.style === "dashed" ? "-.->" : "-->";
    lines.push(lbl ? `  ${nodeId(e.from)} ${arrow}|${lbl}| ${nodeId(e.to)}` : `  ${nodeId(e.from)} ${arrow} ${nodeId(e.to)}`);
  }
  // group node names by domain class, assign, and emit one classDef per used domain
  const byCls = new Map<string, { pkg: string; ids: string[] }>();
  for (const n of [...nodes].sort((a, b) => a.name.localeCompare(b.name))) {
    const c = cls(n.pkg);
    (byCls.get(c) ?? byCls.set(c, { pkg: n.pkg, ids: [] }).get(c)!).ids.push(nodeId(n.name));
  }
  for (const [c, g] of [...byCls.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const dc = domainColor(g.pkg);
    lines.push(`  class ${g.ids.sort().join(",")} ${c}`);
    lines.push(`  classDef ${c} fill:${dc.fill},stroke:${dc.stroke},color:${dc.text}`);
  }
  const legend = [...new Map(nodes.map((n) => [n.pkg, n.pkg])).keys()].sort()
    .map((pkg) => ({ pkg, fill: domainColor(pkg).fill, stroke: domainColor(pkg).stroke }));
  return { mermaid: lines.join("\n"), legend };
}
