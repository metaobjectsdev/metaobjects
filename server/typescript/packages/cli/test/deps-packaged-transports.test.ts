// FR-023 Phase 2 — the `maven` and `nuget` transports of `meta deps sync` / `check`.
//
// The conformance arm (`dependency-transport-conformance.test.ts`) pins what `sync` writes and how
// each refusal is coded. This file covers what the corpus cannot: `check` against a jar and a
// package whose publisher has moved (or that was never fetched), the message a missing package
// carries (the coordinates and the command that fetches it), the Maven local-repository ladder,
// the NuGet version normalization, and the ZIP reader's refusals.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { METAMODEL_VERSION } from "@metaobjectsdev/metadata";
import { sha256Integrity, type DependencySpec, type Lock } from "@metaobjectsdev/sdk";
import { checkDependencies, packageVersionWarning, planSync } from "../src/lib/dependency-sync.js";
import {
  mavenLocalRepository,
  normalizeNuGetVersion,
  nugetPackagesFolder,
  resolveTransport,
} from "../src/lib/dependency-transports.js";
import { readZipEntries, ZipError } from "../src/lib/zip-read.js";
import { writeZip } from "./zip-write.js";

const ARTIFACTS = resolve(import.meta.dirname, "../../../../../fixtures/dependency-conformance/artifacts");
const V1 = readFileSync(join(ARTIFACTS, "acme-common-v1.json"));
const WIDENED = readFileSync(join(ARTIFACTS, "acme-common-v1-widened.json"));
const NODES = ["acme::common::Address", "acme::common::Audited", "acme::common::Customer"];
const MANIFEST = "metaobjects.pkg.json";
const ARTIFACT = "acme-common.metaobjects.json";

const roots: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mo-packaged-"));
  roots.push(root);
  return root;
}
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function manifestFor(artifact: Buffer, version = "1.0.0"): string {
  return JSON.stringify({
    schema_version: 1,
    name: "acme-common",
    version,
    metamodelVersion: METAMODEL_VERSION,
    artifact: ARTIFACT,
    integrity: sha256Integrity(artifact),
    packages: ["acme::common"],
    nodes: NODES,
  });
}

/** What the S8 publisher leaves in `outputDir` — the manifest and the artifact — packaged as jar resources. */
function jar(artifact: Buffer, version = "1.0.0"): Buffer {
  return writeZip([
    { name: "META-INF/MANIFEST.MF", data: "Manifest-Version: 1.0\r\n" },
    { name: `metaobjects/${MANIFEST}`, data: manifestFor(artifact, version) },
    { name: `metaobjects/${ARTIFACT}`, data: artifact },
  ]);
}

function put(path: string, data: Buffer | string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

function lockOf(spec: DependencySpec, artifact: Buffer): Lock {
  const { name: _name, ...resolvedFrom } = spec;
  return {
    schema_version: 1,
    dependencies: {
      "acme-common": {
        version: "1.0.0",
        metamodelVersion: METAMODEL_VERSION,
        artifact: ARTIFACT,
        integrity: sha256Integrity(artifact),
        packages: ["acme::common"],
        nodes: NODES,
        resolvedFrom,
      },
    },
  } as Lock;
}

const MAVEN: DependencySpec = { name: "acme-common", maven: "com.acme:acme-common-model", version: "1.0.0" };
const NUGET: DependencySpec = { name: "acme-common", nuget: "Acme.Common.Model", version: "1.0.0" };

function mavenEnv(root: string): NodeJS.ProcessEnv {
  return { HOME: join(root, "home"), MAVEN_REPO_LOCAL: join(root, "repo") };
}
const jarPath = (root: string): string =>
  join(root, "repo", "com", "acme", "acme-common-model", "1.0.0", "acme-common-model-1.0.0.jar");

function nugetEnv(root: string): NodeJS.ProcessEnv {
  return { HOME: join(root, "home"), NUGET_PACKAGES: join(root, "pkgs") };
}
const nugetDir = (root: string): string => join(root, "pkgs", "acme.common.model", "1.0.0");

describe("maven transport — check", () => {
  test("a jar whose model still hashes to the lock is current", async () => {
    const root = tempRoot();
    put(jarPath(root), jar(V1));
    const [r] = await checkDependencies(root, [MAVEN], lockOf(MAVEN, V1), mavenEnv(root));
    expect(r?.status).toBe("current");
  });

  test("a republished jar whose model changed is drifted", async () => {
    const root = tempRoot();
    put(jarPath(root), jar(WIDENED));
    const [r] = await checkDependencies(root, [MAVEN], lockOf(MAVEN, V1), mavenEnv(root));
    expect(r?.status).toBe("drifted");
    expect(r?.installedIntegrity).toBe(sha256Integrity(WIDENED));
  });

  test("a jar that is not in the local repository is unresolved and names the coordinates and the fetch command", async () => {
    const root = tempRoot();
    const [r] = await checkDependencies(root, [MAVEN], lockOf(MAVEN, V1), mavenEnv(root));
    expect(r?.status).toBe("unresolved");
    expect(r?.detail).toContain("com.acme:acme-common-model:1.0.0");
    expect(r?.detail).toContain("mvn dependency:get -Dartifact=com.acme:acme-common-model:1.0.0");
    expect(r?.detail).toContain("does not download");
  });

  test("sync refuses with ERR_DEPENDENCY_UNRESOLVED for the same missing jar and writes nothing", async () => {
    const root = tempRoot();
    await expect(planSync(root, [MAVEN], undefined, [], mavenEnv(root))).rejects.toMatchObject({
      code: "ERR_DEPENDENCY_UNRESOLVED",
    });
  });

  test("a different version in the declaration is looked up as its own jar", async () => {
    const root = tempRoot();
    put(jarPath(root), jar(V1));
    const bumped: DependencySpec = { ...MAVEN, version: "2.0.0" } as DependencySpec;
    const [r] = await checkDependencies(root, [bumped], lockOf(MAVEN, V1), mavenEnv(root));
    expect(r?.status).toBe("unresolved");
    expect(r?.detail).toContain("com.acme:acme-common-model:2.0.0");
  });

  test("a jar whose manifest records another version than the declaration warns", async () => {
    const root = tempRoot();
    put(jarPath(root), jar(V1, "0.9.0"));
    const plan = await planSync(root, [MAVEN], undefined, [], mavenEnv(root));
    expect(plan.warnings.join("\n")).toContain("declared Maven artifact com.acme:acme-common-model is 1.0.0");
    expect(plan.warnings.join("\n")).toContain("records 0.9.0");
  });
});

describe("maven transport — the local repository", () => {
  test("$MAVEN_REPO_LOCAL wins, then -Dmaven.repo.local in MAVEN_ARGS and MAVEN_OPTS, then settings.xml, then ~/.m2/repository", () => {
    const home = tempRoot();
    expect(mavenLocalRepository({ HOME: home }).dir).toBe(join(home, ".m2", "repository"));

    put(join(home, ".m2", "settings.xml"), "<settings><localRepository>${user.home}/elsewhere</localRepository></settings>");
    expect(mavenLocalRepository({ HOME: home }).dir).toBe(join(home, "elsewhere"));

    expect(mavenLocalRepository({ HOME: home, MAVEN_OPTS: "-Xmx1g -Dmaven.repo.local=/opt/opts" }).dir).toBe("/opt/opts");
    expect(
      mavenLocalRepository({ HOME: home, MAVEN_OPTS: "-Dmaven.repo.local=/opt/opts", MAVEN_ARGS: '-B -Dmaven.repo.local="/opt/args"' }).dir,
    ).toBe("/opt/args");
    expect(
      mavenLocalRepository({ HOME: home, MAVEN_ARGS: "-Dmaven.repo.local=/opt/args", MAVEN_REPO_LOCAL: "/opt/env" }),
    ).toEqual({ dir: "/opt/env", from: "$MAVEN_REPO_LOCAL" });
  });

  test("a settings.xml localRepository that is commented out is ignored", () => {
    const home = tempRoot();
    put(join(home, ".m2", "settings.xml"), "<settings><!-- <localRepository>/nowhere</localRepository> --></settings>");
    expect(mavenLocalRepository({ HOME: home }).dir).toBe(join(home, ".m2", "repository"));
  });

  test("a group id with dots is a directory per segment", () => {
    const root = tempRoot();
    put(jarPath(root), jar(V1));
    expect(resolveTransport(root, MAVEN, mavenEnv(root)).packageVersion).toBe("1.0.0");
  });

  test("a coordinate that carries a version, or a version with a path separator, is refused", () => {
    const root = tempRoot();
    const env = mavenEnv(root);
    expect(() => resolveTransport(root, { ...MAVEN, maven: "com.acme:acme-common-model:1.0.0" } as DependencySpec, env)).toThrow(
      "groupId:artifactId",
    );
    expect(() => resolveTransport(root, { ...MAVEN, version: "../1.0.0" } as DependencySpec, env)).toThrow("not a Maven version");
  });
});

describe("nuget transport — check", () => {
  function extractedPackage(root: string, artifact: Buffer, version = "1.0.0"): void {
    put(join(nugetDir(root), "metaobjects", MANIFEST), manifestFor(artifact, version));
    put(join(nugetDir(root), "metaobjects", ARTIFACT), artifact);
  }

  test("a package whose model still hashes to the lock is current", async () => {
    const root = tempRoot();
    extractedPackage(root, V1);
    const [r] = await checkDependencies(root, [NUGET], lockOf(NUGET, V1), nugetEnv(root));
    expect(r?.status).toBe("current");
  });

  test("a republished package whose model changed is drifted", async () => {
    const root = tempRoot();
    extractedPackage(root, WIDENED);
    const [r] = await checkDependencies(root, [NUGET], lockOf(NUGET, V1), nugetEnv(root));
    expect(r?.status).toBe("drifted");
  });

  test("a package that is not in the cache is unresolved and names the id, version and fetch command", async () => {
    const root = tempRoot();
    const [r] = await checkDependencies(root, [NUGET], lockOf(NUGET, V1), nugetEnv(root));
    expect(r?.status).toBe("unresolved");
    expect(r?.detail).toContain("Acme.Common.Model 1.0.0");
    expect(r?.detail).toContain("dotnet restore");
    expect(r?.detail).toContain("does not download");
  });

  test("a package the cache holds only as a .nupkg is read from the archive", async () => {
    const root = tempRoot();
    put(join(nugetDir(root), "acme.common.model.1.0.0.nupkg"), jar(V1));
    const [r] = await checkDependencies(root, [NUGET], lockOf(NUGET, V1), nugetEnv(root));
    expect(r?.status).toBe("current");
  });

  test("a version differing only by trailing zeros or case matches the manifest's", () => {
    expect(packageVersionWarning("acme-common", NUGET, "1.0", "1.0.0")).toBeUndefined();
    expect(packageVersionWarning("acme-common", NUGET, "1.0.0-RC.1", "1.0.0-rc.1")).toBeUndefined();
    expect(packageVersionWarning("acme-common", NUGET, "1.0.1", "1.0.0")).toContain("NuGet package Acme.Common.Model");
  });

  test("normalizeNuGetVersion follows NuGet's folder naming", () => {
    expect(normalizeNuGetVersion("1.0")).toBe("1.0.0");
    expect(normalizeNuGetVersion("1.0.0.0")).toBe("1.0.0");
    expect(normalizeNuGetVersion("1.0.0.1")).toBe("1.0.0.1");
    expect(normalizeNuGetVersion("01.2.3")).toBe("1.2.3");
    expect(normalizeNuGetVersion("1.0.0-Beta.2+build5")).toBe("1.0.0-beta.2");
  });

  test("$NUGET_PACKAGES wins over the default folder under HOME", () => {
    expect(nugetPackagesFolder({ HOME: "/h", NUGET_PACKAGES: "/n" }).dir).toBe("/n");
    expect(nugetPackagesFolder({ HOME: "/h" }).dir).toBe(join("/h", ".nuget", "packages"));
  });
});

describe("zip reader", () => {
  test("reads stored and deflated entries under a prefix and skips directories", () => {
    const root = tempRoot();
    const path = join(root, "a.zip");
    put(
      path,
      writeZip([
        { name: "metaobjects/", data: "" },
        { name: "metaobjects/a.json", data: '{"a":1}' },
        { name: "metaobjects/b.bin", data: Buffer.from([1, 2, 3]), stored: true },
        { name: "other/c.json", data: "{}" },
      ]),
    );
    const entries = readZipEntries(path, "metaobjects/");
    expect(entries.map((e) => e.name)).toEqual(["metaobjects/a.json", "metaobjects/b.bin"]);
    expect(entries[0]?.data.toString()).toBe('{"a":1}');
    expect([...(entries[1]?.data ?? [])]).toEqual([1, 2, 3]);
  });

  test("refuses a file that is not a ZIP and an entry that climbs out of the extraction directory", () => {
    const root = tempRoot();
    put(join(root, "no.zip"), "plain text, long enough to scan for a record but holding none");
    expect(() => readZipEntries(join(root, "no.zip"))).toThrow(ZipError);
    put(join(root, "slip.zip"), writeZip([{ name: "metaobjects/../../escape.json", data: "{}" }]));
    expect(() => readZipEntries(join(root, "slip.zip"), "metaobjects/")).toThrow("escape");
  });

  test("a damaged jar is unresolved, naming the jar", () => {
    const root = tempRoot();
    put(jarPath(root), "not a jar");
    expect(() => resolveTransport(root, MAVEN, mavenEnv(root))).toThrow("could not be read");
  });
});
