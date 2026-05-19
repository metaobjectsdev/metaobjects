import { describe, it, expect } from "bun:test";
import {
  packageToPath,
  entityOutputPath,
  crossEntitySpecifier,
  barrelEntrySpecifier,
  relativeModuleSpecifier,
} from "../src/import-path.js";

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
});
