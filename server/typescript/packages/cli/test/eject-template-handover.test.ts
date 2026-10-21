// `meta eject` hands over the template modules a generator calls (ADR-0034 Amendment 8): what
// a project holds after it, how a re-run treats it, how `--list` reports it, and what the
// install line asks for. The mechanism is template-eject.test.ts; what it achieves for every
// generator is eject-templates-contract.test.ts.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ejectCommand, ejectGenerator } from "../src/commands/eject.js";

let cwd: string;
let logged: string[];
const origLog = console.log;
const origErr = console.error;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "mo-eject-handover-"));
  logged = [];
  console.log = (...a: unknown[]) => { logged.push(a.join(" ")); };
  console.error = () => {};
});
afterEach(() => {
  console.log = origLog;
  console.error = origErr;
  rmSync(cwd, { recursive: true, force: true });
});

const read = (rel: string): string => readFileSync(join(cwd, rel), "utf8");

describe("the hand-over", () => {
  test("a generator is written beside the template modules it calls, and imports them from there", async () => {
    const r = await ejectGenerator({ cwd, name: "entity" });
    const paths = (r.templates?.files ?? []).map((f) => f.path);
    expect(paths).toContain("codegen/templates/entity-file.ts");
    expect(paths).toContain("codegen/templates/zod-validators.ts");
    expect(paths.every((p) => p.startsWith("codegen/templates/"))).toBe(true);
    expect(r.templates?.files.every((f) => f.status === "created")).toBe(true);

    const generator = read("codegen/generators/entity.ts");
    // The renderers come from the project; the engine from the package's engine entry.
    expect(generator).toContain('from "../templates/entity-file.js"');
    expect(generator).toContain('from "@metaobjectsdev/codegen-ts/engine"');
    expect(generator).not.toMatch(/renderEntityFile[^;]*from "@metaobjectsdev\/codegen-ts"/);
    // A copy imports the engine through the package entry, never a path into the package.
    expect(read("codegen/templates/entity-file.ts")).not.toContain('from "../');
  });

  test("a generator that calls no template module hands over none", async () => {
    const r = await ejectGenerator({ cwd, name: "barrel" });
    expect(r.templates).toBeUndefined();
    expect(existsSync(join(cwd, "codegen/templates"))).toBe(false);
  });

  test("a client-tier generator reaches the core package's templates through its own copies", async () => {
    const r = await ejectGenerator({ cwd, name: "hooks" });
    const paths = (r.templates?.files ?? []).map((f) => f.path);
    expect(paths).toContain("codegen/templates/hooks-file.ts");
    // `hooks-file` is in the tanstack package; the modules the generator and it call in the
    // core one are copied beside it, and the tanstack copy reaches them by path.
    expect(paths).toContain("codegen/templates/entity-meta-file.ts");
    expect(read("codegen/generators/hooks.ts")).toContain('from "../templates/entity-meta-file.js"');
    // The model questions it asks (the primary key, the TPH walk) are engine, so the query and
    // Zod emitters are not copied for one lookup each.
    expect(read("codegen/templates/hooks-file.ts")).not.toContain('from "./queries.js"');
    expect(paths).not.toContain("codegen/templates/queries.ts");
    expect(paths).not.toContain("codegen/templates/zod-validators.ts");
    // Which names the project must be able to resolve: the packages, not a codegen package it no longer calls into.
    expect(r.templatePackages).toEqual(["@metaobjectsdev/codegen-ts", "@metaobjectsdev/metadata"]);
  });

  test("two generators that call one module share one copy, and the second says it was already there", async () => {
    await ejectGenerator({ cwd, name: "entity" });
    const r = await ejectGenerator({ cwd, name: "queries" });
    const shared = r.templates?.files.find((f) => f.path === "codegen/templates/zod-validators.ts");
    expect(shared?.status).toBe("preserved");
    expect(shared?.comparison?.verdict).toBe("identical");
    // What only `queries` calls was created.
    expect(r.templates?.files.find((f) => f.path === "codegen/templates/queries.ts")?.status).toBe("created");
  });

  test("a module the adopter changed is kept on a re-run, and replaced by --force", async () => {
    await ejectGenerator({ cwd, name: "names" });
    const path = join(cwd, "codegen/templates/names-decl.ts");
    writeFileSync(path, `${readFileSync(path, "utf8")}\n// MINE\n`);

    const kept = await ejectGenerator({ cwd, name: "names" });
    const row = kept.templates?.files.find((f) => f.path === "codegen/templates/names-decl.ts");
    expect(row?.status).toBe("preserved");
    expect(row?.comparison?.verdict).toBe("differs");
    expect(readFileSync(path, "utf8")).toContain("// MINE");

    const forced = await ejectGenerator({ cwd, name: "names", force: true });
    expect(forced.templates?.files.find((f) => f.path === "codegen/templates/names-decl.ts")?.status).toBe("replaced");
    expect(readFileSync(path, "utf8")).not.toContain("// MINE");
  });

  test("a kept generator from before the hand-over gets no template modules it would never call", async () => {
    // The 1.0 shape imported its renderers from the package entry. Copying modules beside
    // it would be dead code, so eject leaves it as it is, as it does for the adapter copy.
    mkdirSync(join(cwd, "codegen/generators"), { recursive: true });
    writeFileSync(
      join(cwd, "codegen/generators/names.ts"),
      '// my 1.0 names generator\nimport { renderNamesDecl } from "@metaobjectsdev/codegen-ts";\n',
    );
    const r = await ejectGenerator({ cwd, name: "names" });
    expect(r.status).toBe("preserved");
    expect(r.templates).toBeUndefined();
    expect(existsSync(join(cwd, "codegen/templates"))).toBe(false);
  });

  test("the install line names what the copies import outside the project, with the range the package declares", async () => {
    // `requirements` copies a TOON writer, which is a third-party package.
    await ejectCommand(["requirements"], cwd, "json");
    const doc = JSON.parse(logged.join("\n")) as { install: { dev: string[]; command: string }; ejected: { templates?: { path: string }[] }[] };
    expect(doc.install.dev.some((p) => p.startsWith("@toon-format/toon@"))).toBe(true);
    expect(doc.install.dev.some((p) => p.startsWith("@metaobjectsdev/codegen-ts@"))).toBe(true);
    expect(doc.install.dev.some((p) => p.startsWith("ts-poet"))).toBe(false);
    expect((doc.ejected[0]?.templates ?? []).map((f) => f.path)).toContain("codegen/templates/generators/requirements-toon.ts");
  });
});

describe("meta eject --list reports the copies a project owns", () => {
  test("identical, differing, and a file the package would not write", async () => {
    await ejectCommand(["names"], cwd, "text");
    logged = [];
    writeFileSync(join(cwd, "codegen/templates/names-decl.ts"), "// MINE\nexport const x = 1;\n");
    writeFileSync(join(cwd, "codegen/templates/extra.ts"), "export const extra = 1;\n");

    expect(await ejectCommand(["--list"], cwd, "text")).toBe(0);
    const text = logged.join("\n");
    expect(text).toContain("Template source this project owns (codegen/templates/)");
    expect(text).toContain("codegen/templates/names-decl.ts  [DIFFERS:");
    expect(text).toContain("codegen/templates/extra.ts  [not in the package — yours, or removed upstream]");
    expect(text).toContain("diff -u node_modules/@metaobjectsdev/codegen-ts/src/templates/names-decl.ts codegen/templates/names-decl.ts");
    // The generator file itself is untouched, but the generator is not "identical": one of
    // the renderers it owns differs, and the row says which.
    expect(text).not.toContain("names  [owned — identical to the reference]");
    expect(text).toContain("names  [owned — DIFFERS: generator identical, 1 renderer(s) differ]");
    expect(text).toContain("renderer codegen/templates/names-decl.ts  [DIFFERS:");
  });

  test("a generator is identical only when its file AND every renderer it owns are (text and JSON)", async () => {
    await ejectCommand(["names"], cwd, "text");
    logged = [];
    await ejectCommand(["--list"], cwd, "text");
    expect(logged.join("\n")).toContain("names  [owned — identical to the reference]");

    // A stale renderer, the generator file untouched: the E1 repro.
    appendFileSync(join(cwd, "codegen/templates/names-decl.ts"), "\n// stale line from an older release\n");
    logged = [];
    await ejectCommand(["--list"], cwd, "text");
    const text = logged.join("\n");
    expect(text).not.toContain("names  [owned — identical to the reference]");
    expect(text).toContain("names  [owned — DIFFERS: generator identical, 1 renderer(s) differ]");
    expect(text).toContain("renderer codegen/templates/names-decl.ts  [DIFFERS: 0 line(s) behind, 1 line(s) of your own]");

    logged = [];
    await ejectCommand(["--list"], cwd, "json");
    const doc = JSON.parse(logged.join("\n")) as {
      generators: { name: string; status: string; templates?: { path: string; status: string; own: number }[] }[];
    };
    const row = doc.generators.find((g) => g.name === "names")!;
    expect(row.status).toBe("differs");
    expect(row.templates!.find((t) => t.path === "codegen/templates/names-decl.ts")).toMatchObject({ status: "differs", own: 1 });
  });

  test("a renderer another generator owns does not flag this one", async () => {
    await ejectCommand(["names"], cwd, "text");
    await ejectCommand(["barrel"], cwd, "text");
    appendFileSync(join(cwd, "codegen/templates/names-decl.ts"), "\n// mine\n");
    logged = [];
    await ejectCommand(["--list"], cwd, "text");
    const text = logged.join("\n");
    expect(text).toContain("barrel  [owned — identical to the reference]");
  });

  test("a project with no template copy prints no section for them", async () => {
    await ejectCommand(["barrel"], cwd, "text");
    logged = [];
    await ejectCommand(["--list"], cwd, "text");
    expect(logged.join("\n")).not.toContain("Template source this project owns");
  });
});

describe("the text report", () => {
  test("says the code that writes the output is the project's now, and how many files were copied", async () => {
    await ejectCommand(["names"], cwd, "text");
    const text = logged.join("\n");
    expect(text).toContain("The code this generator calls to write its output is yours too");
    expect(text).toContain("Copied 1 file(s) into codegen/templates/");
  });
});
