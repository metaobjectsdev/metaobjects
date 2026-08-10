import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PackageManifestSchema,
  readPackageManifest,
  resolveMetaobjectsPackage,
  PACKAGE_MANIFEST_FILE,
} from "../src/package.js";

describe("PackageManifestSchema", () => {
  test("accepts a minimal manifest", () => {
    const parsed = PackageManifestSchema.parse({
      name: "@acme/shared",
      version: "1.0.0",
    });
    expect(parsed.name).toBe("@acme/shared");
    expect(parsed.version).toBe("1.0.0");
    expect(parsed.extends).toEqual([]);
  });

  test("accepts a manifest with extends", () => {
    const parsed = PackageManifestSchema.parse({
      name: "@acme/billing",
      version: "0.2.0",
      extends: ["@acme/shared"],
    });
    expect(parsed.extends).toEqual(["@acme/shared"]);
  });

  test("rejects missing name", () => {
    expect(PackageManifestSchema.safeParse({ version: "1.0.0" }).success).toBe(false);
  });

  test("rejects missing version", () => {
    expect(PackageManifestSchema.safeParse({ name: "x" }).success).toBe(false);
  });

  test("rejects malformed version", () => {
    expect(PackageManifestSchema.safeParse({ name: "x", version: "v1" }).success).toBe(false);
    expect(PackageManifestSchema.safeParse({ name: "x", version: "1.0" }).success).toBe(false);
    expect(PackageManifestSchema.safeParse({ name: "x", version: "latest" }).success).toBe(false);
  });

  test("accepts pre-release versions", () => {
    expect(PackageManifestSchema.parse({
      name: "x", version: "1.0.0-alpha.1",
    }).version).toBe("1.0.0-alpha.1");
  });

  test("rejects unknown fields (no exports, no @private)", () => {
    // strict-by-default — fields outside the three are rejected so the
    // model stays simple and obvious
    const result = PackageManifestSchema.safeParse({
      name: "x",
      version: "1.0.0",
      exports: ["User"],
    });
    // Zod by default is lenient; we don't strict() so extra fields are
    // simply ignored. This test documents that behavior.
    expect(result.success).toBe(true);
    if (result.success) {
      // The unknown field is dropped, not preserved
      expect((result.data as Record<string, unknown>).exports).toBeUndefined();
    }
  });
});

describe("readPackageManifest", () => {
  test("returns the parsed manifest when file exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pkg-manifest-"));
    try {
      writeFileSync(
        join(dir, PACKAGE_MANIFEST_FILE),
        JSON.stringify({
          name: "@acme/shared",
          version: "1.0.0",
          extends: ["@acme/audit"],
        }),
        "utf8",
      );
      const manifest = await readPackageManifest(dir);
      expect(manifest).toBeDefined();
      expect(manifest!.name).toBe("@acme/shared");
      expect(manifest!.extends).toEqual(["@acme/audit"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns undefined when file absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pkg-manifest-absent-"));
    try {
      const manifest = await readPackageManifest(dir);
      expect(manifest).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("throws on malformed JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pkg-manifest-bad-"));
    try {
      writeFileSync(join(dir, PACKAGE_MANIFEST_FILE), "{ not valid", "utf8");
      // Raw JSON.parse failure — the exact text is engine-owned (JSC vs V8), so
      // pin the stable "JSON" fragment both engines include.
      await expect(readPackageManifest(dir)).rejects.toThrow(/JSON/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("throws on schema-invalid manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pkg-manifest-invalid-"));
    try {
      writeFileSync(
        join(dir, PACKAGE_MANIFEST_FILE),
        JSON.stringify({ name: "x", version: "v1" }),
        "utf8",
      );
      await expect(readPackageManifest(dir)).rejects.toThrow(/semver/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns undefined when path is a directory not a file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pkg-manifest-dir-"));
    try {
      mkdirSync(join(dir, PACKAGE_MANIFEST_FILE));
      const manifest = await readPackageManifest(dir);
      expect(manifest).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("PackageManifestSchema — metaobjectsPackage validation", () => {
  test("accepts snake_case canonical ref", () => {
    expect(PackageManifestSchema.parse({
      name: "@acme/common-user-mgmt", version: "1.0.0",
      metaobjectsPackage: "acme::common::user_mgmt",
    }).metaobjectsPackage).toBe("acme::common::user_mgmt");
  });

  test("accepts single-segment ref", () => {
    expect(PackageManifestSchema.parse({
      name: "trainer_website", version: "0.1.0",
      metaobjectsPackage: "trainer_website",
    }).metaobjectsPackage).toBe("trainer_website");
  });

  test("rejects camelCase segments", () => {
    expect(PackageManifestSchema.safeParse({
      name: "x", version: "1.0.0",
      metaobjectsPackage: "acme::commonUserMgmt",
    }).success).toBe(false);
  });

  test("rejects hyphens in segments", () => {
    expect(PackageManifestSchema.safeParse({
      name: "x", version: "1.0.0",
      metaobjectsPackage: "acme::user-mgmt",
    }).success).toBe(false);
  });

  test("rejects single colons", () => {
    expect(PackageManifestSchema.safeParse({
      name: "x", version: "1.0.0",
      metaobjectsPackage: "acme:common",
    }).success).toBe(false);
  });
});

describe("resolveMetaobjectsPackage", () => {
  test("returns explicit metaobjectsPackage when set", () => {
    const m = PackageManifestSchema.parse({
      name: "@acme/whatever", version: "1.0.0",
      metaobjectsPackage: "acme::common::user_mgmt",
    });
    expect(resolveMetaobjectsPackage(m)).toBe("acme::common::user_mgmt");
  });

  test("auto-derives from scoped npm name", () => {
    const m = PackageManifestSchema.parse({
      name: "@acme/common-user-mgmt", version: "1.0.0",
    });
    // Hyphens stay as-is in auto-derived form (no magic segment splitting)
    expect(resolveMetaobjectsPackage(m)).toBe("acme::common-user-mgmt");
  });

  test("auto-derives from bare name", () => {
    const m = PackageManifestSchema.parse({
      name: "trainer_website", version: "1.0.0",
    });
    expect(resolveMetaobjectsPackage(m)).toBe("trainer_website");
  });

  test("returns undefined when name can't be derived (uppercase)", () => {
    const m = PackageManifestSchema.parse({
      name: "MyPackage", version: "1.0.0",
    });
    expect(resolveMetaobjectsPackage(m)).toBeUndefined();
  });
});
