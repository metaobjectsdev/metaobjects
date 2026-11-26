import type { MetaData } from "@metaobjectsdev/metadata";
import { describe, it, expect } from "bun:test";
import {
  packageToPath,
  entityOutputPath,
  crossEntitySpecifier,
  barrelEntrySpecifier,
  relativeModuleSpecifier,
  type ResolvedTarget,
  entityModuleSpecifier,
  siblingSpecifier,
  barrelModuleSpecifier,
  valueObjectModuleSpecifier,
} from "../src/import-path.js";
import { CodegenError } from "../src/errors.js";

const model = (over: Partial<ResolvedTarget> = {}): ResolvedTarget => ({
  name: "default", outDir: "db/gen", importBase: "@acme/db/generated",
  outputLayout: "package", dbImport: "../index", runtime: true, ...over,
});
const web = (over: Partial<ResolvedTarget> = {}): ResolvedTarget => ({
  name: "web", outDir: "web/gen", importBase: undefined,
  outputLayout: "package", dbImport: "../index", runtime: true, ...over,
});

describe("entityModuleSpecifier", () => {
  it("same target → relative (honors extStyle), package layout", () => {
    expect(entityModuleSpecifier(model(), model(), "shop::commerce", "Program", "none"))
      .toBe("./Program");
    expect(entityModuleSpecifier(model(), model(), "shop::commerce", "Program", "js"))
      .toBe("./Program.js");
  });
  it("same target → relative, flat layout", () => {
    expect(entityModuleSpecifier(model({ outputLayout: "flat" }), model({ outputLayout: "flat" }), "shop::commerce", "Program", "none"))
      .toBe("./Program");
  });
  it("cross target, package layout → extension-less importBase path (extStyle ignored)", () => {
    expect(entityModuleSpecifier(web(), model(), "shop::commerce", "Program", "js"))
      .toBe("@acme/db/generated/shop/commerce/Program");
  });
  it("cross target, flat layout → importBase + entity, no package path", () => {
    expect(entityModuleSpecifier(web({ outputLayout: "flat" }), model({ outputLayout: "flat" }), "shop::commerce", "Program", "none"))
      .toBe("@acme/db/generated/Program");
  });
  it("cross target, entity at root package → importBase + entity", () => {
    expect(entityModuleSpecifier(web(), model(), undefined, "Tag", "none"))
      .toBe("@acme/db/generated/Tag");
  });
  it("cross target without importBase → throws", () => {
    expect(() => entityModuleSpecifier(web(), model({ importBase: undefined }), "shop::commerce", "Program", "none"))
      .toThrow(/importBase/);
  });
});

describe("siblingSpecifier", () => {
  it("always same-target relative, package layout", () => {
    expect(siblingSpecifier(web(), "shop::commerce", "Program.columns", "none")).toBe("./Program.columns");
  });
  it("honors extStyle", () => {
    expect(siblingSpecifier(web(), "shop::commerce", "Program.columns", "js")).toBe("./Program.columns.js");
  });
});

describe("barrelModuleSpecifier", () => {
  it("same target (package) → './<pkg-path>/<entity>'", () => {
    expect(barrelModuleSpecifier(model(), model(), "shop::commerce", "Program", "none"))
      .toBe("./shop/commerce/Program");
  });
  it("cross target → extension-less importBase path", () => {
    expect(barrelModuleSpecifier(web(), model(), "shop::commerce", "Program", "none"))
      .toBe("@acme/db/generated/shop/commerce/Program");
  });
});

describe("packageToPath", () => {
  it("maps :: segments to / path; empty/undefined → ''", () => {
    expect(packageToPath("a::b::c")).toBe("a/b/c");
    expect(packageToPath("acme::commerce")).toBe("acme/commerce");
    expect(packageToPath("")).toBe("");
    expect(packageToPath(undefined)).toBe("");
  });
});

describe("entityOutputPath", () => {
  it("flat → bare filename", () => {
    expect(entityOutputPath("flat", "acme::commerce", "Program.ts")).toBe("Program.ts");
    expect(entityOutputPath("flat", undefined, "Program.ts")).toBe("Program.ts");
  });
  it("package → package sub-path prefix; no package → root", () => {
    expect(entityOutputPath("package", "acme::commerce", "Program.ts")).toBe("acme/commerce/Program.ts");
    expect(entityOutputPath("package", undefined, "Program.ts")).toBe("Program.ts");
  });
});

describe("crossEntitySpecifier", () => {
  it("flat → always './<entity>'", () => {
    expect(crossEntitySpecifier("flat", "acme::commerce", "acme::users", "User", "none")).toBe("./User");
  });
  it("package, same package → './<entity>'", () => {
    expect(crossEntitySpecifier("package", "acme::commerce", "acme::commerce", "Purchase", "none")).toBe("./Purchase");
  });
  it("package, different package → relative path", () => {
    expect(crossEntitySpecifier("package", "acme::commerce", "acme::users", "User", "none")).toBe("../users/User");
  });
  it("package, target at root → relative up to root", () => {
    expect(crossEntitySpecifier("package", "acme::commerce", undefined, "Tag", "none")).toBe("../../Tag");
  });
  it("package, importing entity at root → into a package", () => {
    expect(crossEntitySpecifier("package", undefined, "acme::commerce", "Program", "none")).toBe("./acme/commerce/Program");
  });
  it("honors extStyle", () => {
    expect(crossEntitySpecifier("package", "acme::commerce", "acme::commerce", "Purchase", "js")).toBe("./Purchase.js");
  });
});

describe("barrelEntrySpecifier", () => {
  it("flat → './<entity>'", () => {
    expect(barrelEntrySpecifier("flat", "acme::commerce", "Program", "none")).toBe("./Program");
  });
  it("package → './<pkg-path>/<entity>'; no package → './<entity>'", () => {
    expect(barrelEntrySpecifier("package", "acme::commerce", "Program", "none")).toBe("./acme/commerce/Program");
    expect(barrelEntrySpecifier("package", undefined, "Tag", "none")).toBe("./Tag");
  });
});

describe("relativeModuleSpecifier (dbImport adjustment) — extStyle 'none'", () => {
  it("flat → unchanged", () => {
    expect(relativeModuleSpecifier("flat", "acme::commerce", "../index", "none")).toBe("../index");
  });
  it("package, non-relative specifier → unchanged (depth-invariant)", () => {
    expect(relativeModuleSpecifier("package", "acme::commerce", "~/server/db", "none")).toBe("~/server/db");
    expect(relativeModuleSpecifier("package", "acme::commerce", "@acme/db", "none")).toBe("@acme/db");
  });
  it("package, relative '../' specifier → extra '../' per package segment", () => {
    expect(relativeModuleSpecifier("package", "acme::commerce", "../index", "none")).toBe("../../../index");
    expect(relativeModuleSpecifier("package", undefined, "../index", "none")).toBe("../index");
  });
  it("package, relative './' specifier → strip './' and prepend '../' per segment", () => {
    expect(relativeModuleSpecifier("package", "acme::commerce", "./index", "none")).toBe("../../index");
  });
  it("package, single-segment package, './' specifier", () => {
    expect(relativeModuleSpecifier("package", "acme", "./index", "none")).toBe("../index");
  });
});

describe("relativeModuleSpecifier — extStyle 'js' extension-ifies relative specifiers", () => {
  it("flat, relative → gets .js (nodenext-safe)", () => {
    expect(relativeModuleSpecifier("flat", "acme::commerce", "../db", "js")).toBe("../db.js");
    expect(relativeModuleSpecifier("flat", undefined, "./enums", "js")).toBe("./enums.js");
  });
  it("non-relative specifier → never extensioned (package / alias)", () => {
    expect(relativeModuleSpecifier("flat", "acme::commerce", "@acme/db", "js")).toBe("@acme/db");
    expect(relativeModuleSpecifier("flat", "acme::commerce", "~/server/db", "js")).toBe("~/server/db");
  });
  it("already-extensioned relative specifier → not double-appended", () => {
    expect(relativeModuleSpecifier("flat", "acme::commerce", "../db.js", "js")).toBe("../db.js");
  });
  it("package layout composes depth adjustment with the .js extension", () => {
    expect(relativeModuleSpecifier("package", "acme::commerce", "../db", "js")).toBe("../../../db.js");
  });
});

describe("valueObjectModuleSpecifier", () => {
  // The node a field's @objectRef names — only its name and resolution key are read.
  const node = (fqn: string): MetaData => {
    const name = fqn.split("::").at(-1)!;
    return { name, resolutionKey: () => fqn } as unknown as MetaData;
  };
  const triple = node("acme::common::Triple");
  const samePkg = node("acme::ai::SamePkgVo");

  it("flat layout → same-dir ./<VO> (extStyle none, no .js)", () => {
    expect(valueObjectModuleSpecifier(triple, "Triple", "acme::ai", "flat", "none")).toBe("./Triple");
  });

  it("flat layout honors extStyle js", () => {
    expect(valueObjectModuleSpecifier(triple, "Triple", "acme::ai", "flat", "js")).toBe("./Triple.js");
  });

  it("package layout, SAME package → ./<VO>", () => {
    expect(valueObjectModuleSpecifier(samePkg, "SamePkgVo", "acme::ai", "package", "none")).toBe("./SamePkgVo");
  });

  it("package layout, CROSS package → relative path between packages", () => {
    // The whole point of the fix: NOT a flat ./Triple, but ../common/Triple.
    expect(valueObjectModuleSpecifier(triple, "Triple", "acme::ai", "package", "none")).toBe("../common/Triple");
  });

  it("two same-named value objects in two packages resolve to two modules (keyed by node)", () => {
    expect(valueObjectModuleSpecifier(node("acme::alpha::Note"), "Note", "acme::app", "package", "none")).toBe("../alpha/Note");
    expect(valueObjectModuleSpecifier(node("acme::beta::Note"), "Note", "acme::app", "package", "none")).toBe("../beta/Note");
  });

  it("unresolved VO falls back to fromPkg (same-dir)", () => {
    expect(valueObjectModuleSpecifier(undefined, "Ghost", "acme::ai", "package", "none")).toBe("./Ghost");
  });

  it("refuses the pre-1.3 call shape (a name first) with a named error, not a bare TypeError", () => {
    // An owned template copied from 1.2 calls (name, ctx.packageOf, fromPkg, layout, extStyle).
    // Both shapes take five arguments, so the call has to be refused here, by name.
    const packageOf = (name: string): string | undefined => (name === "Triple" ? "acme::common" : undefined);
    const oldShape = valueObjectModuleSpecifier as unknown as (...args: unknown[]) => string;
    const call = (): string => oldShape("Triple", packageOf, "acme::ai", "package", "none");
    expect(call).toThrow(CodegenError);
    expect(call).toThrow(/first argument must be the value object's node, got the string "Triple"/);
    expect(call).toThrow(/valueObjectModuleSpecifier\(vo, voName, fromPkg, layout, extStyle\)/);
    expect(call).toThrow(/ctx\.resolveValueObject\(field\)/);
    expect(call).not.toThrow(/resolutionKey is not a function/);
  });

  it("refuses any first argument that is not a node", () => {
    const loose = valueObjectModuleSpecifier as unknown as (...args: unknown[]) => string;
    expect(() => loose(null, "Triple", "acme::ai", "flat", "none")).toThrow(/got null/);
    expect(() => loose({ name: "Triple" }, "Triple", "acme::ai", "flat", "none")).toThrow(/got an object with no resolutionKey\(\)/);
  });
});
