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

const model = (over: Partial<ResolvedTarget> = {}): ResolvedTarget => ({
  name: "default", outDir: "db/gen", importBase: "@mf/db/generated",
  outputLayout: "package", dbImport: "../index", ...over,
});
const web = (over: Partial<ResolvedTarget> = {}): ResolvedTarget => ({
  name: "web", outDir: "web/gen", importBase: undefined,
  outputLayout: "package", dbImport: "../index", ...over,
});

describe("entityModuleSpecifier", () => {
  it("same target → relative (honors extStyle), package layout", () => {
    expect(entityModuleSpecifier(model(), model(), "mikes::commerce", "Program", "none"))
      .toBe("./Program");
    expect(entityModuleSpecifier(model(), model(), "mikes::commerce", "Program", "js"))
      .toBe("./Program.js");
  });
  it("same target → relative, flat layout", () => {
    expect(entityModuleSpecifier(model({ outputLayout: "flat" }), model({ outputLayout: "flat" }), "mikes::commerce", "Program", "none"))
      .toBe("./Program");
  });
  it("cross target, package layout → extension-less importBase path (extStyle ignored)", () => {
    expect(entityModuleSpecifier(web(), model(), "mikes::commerce", "Program", "js"))
      .toBe("@mf/db/generated/mikes/commerce/Program");
  });
  it("cross target, flat layout → importBase + entity, no package path", () => {
    expect(entityModuleSpecifier(web({ outputLayout: "flat" }), model({ outputLayout: "flat" }), "mikes::commerce", "Program", "none"))
      .toBe("@mf/db/generated/Program");
  });
  it("cross target, entity at root package → importBase + entity", () => {
    expect(entityModuleSpecifier(web(), model(), undefined, "Tag", "none"))
      .toBe("@mf/db/generated/Tag");
  });
  it("cross target without importBase → throws", () => {
    expect(() => entityModuleSpecifier(web(), model({ importBase: undefined }), "mikes::commerce", "Program", "none"))
      .toThrow(/importBase/);
  });
});

describe("siblingSpecifier", () => {
  it("always same-target relative, package layout", () => {
    expect(siblingSpecifier(web(), "mikes::commerce", "Program.columns", "none")).toBe("./Program.columns");
  });
  it("honors extStyle", () => {
    expect(siblingSpecifier(web(), "mikes::commerce", "Program.columns", "js")).toBe("./Program.columns.js");
  });
});

describe("barrelModuleSpecifier", () => {
  it("same target (package) → './<pkg-path>/<entity>'", () => {
    expect(barrelModuleSpecifier(model(), model(), "mikes::commerce", "Program", "none"))
      .toBe("./mikes/commerce/Program");
  });
  it("cross target → extension-less importBase path", () => {
    expect(barrelModuleSpecifier(web(), model(), "mikes::commerce", "Program", "none"))
      .toBe("@mf/db/generated/mikes/commerce/Program");
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

describe("relativeModuleSpecifier (dbImport adjustment)", () => {
  it("flat → unchanged", () => {
    expect(relativeModuleSpecifier("flat", "acme::commerce", "../index")).toBe("../index");
  });
  it("package, non-relative specifier → unchanged (depth-invariant)", () => {
    expect(relativeModuleSpecifier("package", "acme::commerce", "~/server/db")).toBe("~/server/db");
    expect(relativeModuleSpecifier("package", "acme::commerce", "@acme/db")).toBe("@acme/db");
  });
  it("package, relative '../' specifier → extra '../' per package segment", () => {
    expect(relativeModuleSpecifier("package", "acme::commerce", "../index")).toBe("../../../index");
    expect(relativeModuleSpecifier("package", undefined, "../index")).toBe("../index");
  });
  it("package, relative './' specifier → strip './' and prepend '../' per segment", () => {
    expect(relativeModuleSpecifier("package", "acme::commerce", "./index")).toBe("../../index");
  });
  it("package, single-segment package, './' specifier", () => {
    expect(relativeModuleSpecifier("package", "acme", "./index")).toBe("../index");
  });
});

describe("valueObjectModuleSpecifier", () => {
  const pkgOf = new Map<string, string | undefined>([
    ["Triple", "acme::common"],
    ["SamePkgVo", "acme::ai"],
  ]);

  it("flat layout → same-dir ./<VO> (extStyle none, no .js)", () => {
    expect(valueObjectModuleSpecifier("Triple", pkgOf, "acme::ai", "flat", "none")).toBe("./Triple");
  });

  it("flat layout honors extStyle js", () => {
    expect(valueObjectModuleSpecifier("Triple", pkgOf, "acme::ai", "flat", "js")).toBe("./Triple.js");
  });

  it("package layout, SAME package → ./<VO>", () => {
    expect(valueObjectModuleSpecifier("SamePkgVo", pkgOf, "acme::ai", "package", "none")).toBe("./SamePkgVo");
  });

  it("package layout, CROSS package → relative path between packages", () => {
    // The whole point of the fix: NOT a flat ./Triple, but ../common/Triple.
    expect(valueObjectModuleSpecifier("Triple", pkgOf, "acme::ai", "package", "none")).toBe("../common/Triple");
  });

  it("unknown VO falls back to fromPkg (same-dir)", () => {
    expect(valueObjectModuleSpecifier("Ghost", pkgOf, "acme::ai", "package", "none")).toBe("./Ghost");
  });
});
