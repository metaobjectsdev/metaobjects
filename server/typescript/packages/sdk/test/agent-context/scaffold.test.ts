import { test, expect, describe } from "bun:test";
import { hashContents, planScaffold, agentContextStaleness, AGENT_CONTEXT_MANIFEST_PATH, type Manifest } from "../../src/agent-context/scaffold.js";
import { makeStack } from "../../src/agent-context/resolve.js";
import type { AssembledFile } from "../../src/agent-context/types.js";

const stack = makeStack(["typescript"], ["react"]);
const files: AssembledFile[] = [
  { path: ".metaobjects/AGENTS.md", contents: "always-on v2" },
  { path: ".claude/skills/metaobjects-codegen/SKILL.md", contents: "---\nname: x\n---\nbody v2" },
];

describe("planScaffold", () => {
  test("manifest path is the dotfile under .metaobjects", () => {
    expect(AGENT_CONTEXT_MANIFEST_PATH).toBe(".metaobjects/.agent-context.json");
  });

  test("all-new project: every file is a write; manifest records hashes; no conflicts", () => {
    const d = planScaffold({ stack, assembled: files, prior: undefined, readCurrent: () => undefined, generatedBy: "0.9.0" });
    expect(d.writes.map((w) => w.path).sort()).toEqual(files.map((f) => f.path).sort());
    expect(d.conflicts).toEqual([]);
    expect(d.manifest.files[".metaobjects/AGENTS.md"]).toBe(hashContents("always-on v2"));
    expect(d.manifest.servers).toEqual(["typescript"]);
    expect(d.manifest.clients).toEqual(["react"]);
  });

  test("unmodified file (on-disk hash matches prior manifest) → overwrite, not conflict", () => {
    const prior: Manifest = { version: 1, servers: ["typescript"], clients: ["react"], files: { ".metaobjects/AGENTS.md": hashContents("always-on v1") } };
    const d = planScaffold({
      stack, assembled: [files[0]!], prior,
      readCurrent: (p) => (p === ".metaobjects/AGENTS.md" ? "always-on v1" : undefined),
      generatedBy: "0.9.0",
    });
    expect(d.writes.map((w) => w.path)).toEqual([".metaobjects/AGENTS.md"]);
    expect(d.conflicts).toEqual([]);
  });

  test("hand-edited file (on-disk differs from prior hash) → .new conflict + keep original", () => {
    const prior: Manifest = { version: 1, servers: ["typescript"], clients: ["react"], files: { ".metaobjects/AGENTS.md": hashContents("always-on v1") } };
    const d = planScaffold({
      stack, assembled: [files[0]!], prior,
      readCurrent: () => "I HAND EDITED THIS",
      generatedBy: "0.9.0",
    });
    expect(d.writes).toEqual([]);
    expect(d.conflicts).toEqual([{ path: ".metaobjects/AGENTS.md", newPath: ".metaobjects/AGENTS.md.new", contents: "always-on v2" }]);
  });

  test("file present but no prior manifest record → treat as hand-edited (.new), never clobber", () => {
    const d = planScaffold({ stack, assembled: [files[0]!], prior: undefined, readCurrent: () => "pre-existing unknown", generatedBy: "0.9.0" });
    expect(d.conflicts.map((c) => c.path)).toEqual([".metaobjects/AGENTS.md"]);
  });

  // An orphan is a file the PRIOR manifest tracked that this stack no longer assembles —
  // typically a language fragment left behind by `--refresh-docs --server <other>`. It used
  // to be reported and never deleted, whatever its state, so a python.md sat in a
  // TypeScript project forever while every SKILL.md footer told the reader to "read every
  // references/*.md file in this skill's directory (one per server language in this
  // project's stack)". The three cases below are decided by the SAME hash predicate that
  // already separates `writes` from `conflicts`: we only ever delete a file we wrote and
  // nobody has touched.
  const ORPHAN = ".claude/skills/metaobjects-codegen/references/java.md";
  const priorWith = (hash: string): Manifest => ({
    version: 1, servers: ["typescript", "java"], clients: ["react"], files: { [ORPHAN]: hash },
  });

  test("an orphan still matching the hash we recorded is pruned", () => {
    const d = planScaffold({
      stack, assembled: files, prior: priorWith(hashContents("java fragment v1")),
      readCurrent: (p) => (p === ORPHAN ? "java fragment v1" : undefined),
      generatedBy: "0.9.0",
    });
    // We wrote it and nobody edited it, so deleting is exactly as safe as the overwrite
    // the same predicate already authorises for a file still in the stack.
    expect(d.prunes).toEqual([ORPHAN]);
    expect(d.removed).toEqual([]);
  });

  test("a HAND-EDITED orphan is reported, never pruned", () => {
    const d = planScaffold({
      stack, assembled: files, prior: priorWith(hashContents("java fragment v1")),
      readCurrent: (p) => (p === ORPHAN ? "I ADDED MY OWN NOTES HERE" : undefined),
      generatedBy: "0.9.0",
    });
    // Losing an adopter's writing is worse than leaving a stale file behind.
    expect(d.prunes).toEqual([]);
    expect(d.removed).toEqual([ORPHAN]);
  });

  test("an orphan already gone from disk is neither pruned nor reported", () => {
    const d = planScaffold({
      stack, assembled: files, prior: priorWith("abc"),
      readCurrent: () => undefined, generatedBy: "0.9.0",
    });
    // Nothing to delete and nothing to tell the user about — it just leaves the manifest.
    expect(d.prunes).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  test("a pruned orphan does not survive into the new manifest", () => {
    const d = planScaffold({
      stack, assembled: files, prior: priorWith(hashContents("java fragment v1")),
      readCurrent: (p) => (p === ORPHAN ? "java fragment v1" : undefined),
      generatedBy: "0.9.0",
    });
    // A manifest that still tracked it would re-report it as an orphan on every run.
    expect(Object.keys(d.manifest.files)).not.toContain(ORPHAN);
  });
});

describe("planScaffold generatedBy stamp", () => {
  test("manifest records the MetaObjects version that scaffolded it", () => {
    const d = planScaffold({ stack, assembled: files, prior: undefined, readCurrent: () => undefined, generatedBy: "0.9.0" });
    expect(d.manifest.generatedBy).toBe("0.9.0");
  });
});

describe("agentContextStaleness", () => {
  const m = (generatedBy?: string): Manifest => ({ version: 1, ...(generatedBy !== undefined && { generatedBy }), servers: ["typescript"], clients: ["react"], files: {} });

  test("no agent-context manifest → silent (null)", () => {
    expect(agentContextStaleness({ manifest: undefined, currentVersion: "0.9.0" })).toBeNull();
  });
  test("generatedBy equals installed version → in sync (null)", () => {
    expect(agentContextStaleness({ manifest: m("0.9.0"), currentVersion: "0.9.0" })).toBeNull();
  });
  test("generatedBy differs from installed → warning naming both versions", () => {
    const w = agentContextStaleness({ manifest: m("0.8.0"), currentVersion: "0.9.0" });
    expect(w).toContain("0.8.0");
    expect(w).toContain("0.9.0");
    expect(w).toContain("refresh-docs");
  });
  test("legacy manifest without generatedBy → warning (treated as older)", () => {
    const w = agentContextStaleness({ manifest: m(undefined), currentVersion: "0.9.0" });
    expect(w).toContain("0.9.0");
    expect(w).toContain("refresh-docs");
  });

  // ── the context is AHEAD of the install (publish-what-changed, docs/RELEASING.md) ──
  // A port publishes only when it has a changed product file, so it legitimately sits
  // behind npm — and `meta agent-docs` (npm, the canonical scaffolder for every port)
  // stamps the NEWER version into the manifest. Nudging there is #347's exact shape: the
  // remedy re-stamps the same newer version, so the advisory can never be satisfied and
  // fires forever on a correct setup.
  test("context generated by a NEWER release than the install → silent", () => {
    expect(agentContextStaleness({ manifest: m("0.24.7"), currentVersion: "0.24.4" })).toBeNull();
  });
  test("newer only in the patch → silent", () => {
    expect(agentContextStaleness({ manifest: m("0.24.5"), currentVersion: "0.24.4" })).toBeNull();
  });
  test("context OLDER than the install still nudges — the case the advisory exists for", () => {
    const w = agentContextStaleness({ manifest: m("0.24.4"), currentVersion: "0.24.7" });
    expect(w).toContain("0.24.4");
    expect(w).toContain("0.24.7");
  });

  // The suppression is deliberately narrow: anything we cannot order as a plain release
  // still nudges, preserving the documented "ANY drift nudges" property.
  test("a PRERELEASE context against a final release still nudges", () => {
    expect(agentContextStaleness({ manifest: m("0.24.5-rc.1"), currentVersion: "0.24.4" })).not.toBeNull();
  });
  test("build metadata still nudges", () => {
    expect(agentContextStaleness({ manifest: m("0.24.5+abc"), currentVersion: "0.24.4" })).not.toBeNull();
  });
  test("the unresolved-version sentinel never asserts in-sync", () => {
    expect(agentContextStaleness({ manifest: m("0.24.7"), currentVersion: "0.0.0" })).not.toBeNull();
  });
  test("a non-numeric version still nudges", () => {
    expect(agentContextStaleness({ manifest: m("dev"), currentVersion: "0.24.4" })).not.toBeNull();
  });
});
