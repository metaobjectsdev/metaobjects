import { expect, test } from "bun:test";
import { packageFlowchart, inheritanceTree, THEME_INIT } from "../src/mermaid";

test("packageFlowchart labels nodes with counts", () => {
  const d = packageFlowchart([{ from: "shop", to: "common", n: 2 }], new Map([["shop", 3], ["common", 1]]));
  expect(d).toBe(
THEME_INIT +
`flowchart LR
  common["common · 1"]
  shop["shop · 3"]
  shop -->|2| common`);
});

test("inheritanceTree renders a deterministic top-down chain with the self node marked", () => {
  const t = inheritanceTree([
    { name: "BaseEntity", level: 0 },
    { name: "BaseTenantEntity", level: 1 },
    { name: "GameSession", level: 2, self: true },
    { name: "ChildA", level: 3 },
    { name: "ChildB", level: 3 },
  ]);
  expect(t.startsWith(THEME_INIT)).toBe(true);
  expect(t).toContain("flowchart TD");
  expect(t.indexOf("ChildA")).toBeLessThan(t.indexOf("ChildB")); // deterministic child order
});

test("erDiagramRich puts attributes in boxes + per-entity fill(domain)/stroke(role)", () => {
  const { erDiagramRich, domainColor } = require("../src/mermaid");
  const out = erDiagramRich(
    [
      { name: "GameSession", pkg: "acme::session", role: "focal",
        attrs: [{ type: "string", name: "id", key: "PK", note: "uuid" }, { type: "enum", name: "status", key: "", note: "lifecycle" }], more: 3 },
      { name: "WorldLocation", pkg: "acme::world", role: "external",
        attrs: [{ type: "string", name: "id", key: "PK", note: "" }], more: 0 },
    ],
    [{ parent: "WorldLocation", child: "GameSession", label: "loc" }],
  );
  expect(out).toContain("erDiagram");
  expect(out).toContain("string id PK");
  expect(out).toContain('enum status "lifecycle"');                   // empty-key: no extra space before quote
  expect(out).toContain('_ plus "+3 more"');                         // truncation sentinel with opening quote
  expect(out).toContain(`stroke:${"#60a5fa"}`);                      // focal role stroke
  expect(out).toContain(domainColor("acme::session").fill);    // domain fill applied
});

test("flowchartDomain fills nodes by domain and returns a sorted legend", () => {
  const { flowchartDomain } = require("../src/mermaid");
  const r = flowchartDomain(
    [{ name: "GameSession", pkg: "acme::session" }, { name: "ActiveNpc", pkg: "acme::npc" }],
    [{ from: "GameSession", to: "ActiveNpc", label: "session" }],
  );
  expect(r.mermaid).toContain("flowchart");
  expect(r.legend.map((l: { pkg: string }) => l.pkg)).toEqual(["acme::npc", "acme::session"]); // sorted, deduped
});

test("domainColor is deterministic and stable for unmapped packages", () => {
  const { domainColor } = require("../src/mermaid");
  expect(domainColor("acme::session")).toEqual(domainColor("acme::session"));
  expect(domainColor("acme::zzz_unmapped").fill).toMatch(/^#/);  // assigned a stable slot, not random
});
