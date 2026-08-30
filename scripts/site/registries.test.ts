// The five version coordinates the site publishes.
//
// These are the numbers a reader copies into their own pom or package.json, so a wrong
// one is not a cosmetic defect — it is an install that resolves nothing, or worse, one
// that resolves the wrong release quietly.
//
// The three properties pinned here are the ones that a "just use the version" shortcut
// would break. They are not a restatement of `readRegistries`: each one fails on a
// specific, tempting simplification.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildPayload } from "./payload.js";

const REPO = resolve(import.meta.dirname, "../..");

describe("registries", () => {
  test("npm matches the cli package version — the lockstep anchor", () => {
    // `cli` is the anchor rather than an arbitrary member: it is the package a reader
    // installs, the leaf every other package publishes before, and the one `meta
    // --version` prints. If the payload and it disagree, the page names a version the
    // documented install does not produce.
    const cli = JSON.parse(
      readFileSync(resolve(REPO, "server/typescript/packages/cli/package.json"), "utf8"));
    expect(buildPayload(REPO).registries.npm).toBe(cli.version);
  });

  test("maven is on its own major — never assumed equal to npm", () => {
    // The single most likely wrong simplification: one `version` string for the whole
    // release. Maven runs on its historical major 7, so a shared string is right for at
    // most three of the four and silently wrong for Maven on every release.
    const r = buildPayload(REPO).registries;
    expect(r.maven).toMatch(/^\d+\.\d+\.\d+$/);
    expect(r.maven.split(".")[0]).not.toBe(r.npm.split(".")[0]);
  });

  test("metamodelVersion is its own coordinate, not a package version", () => {
    // ADR-0035 Amendment 2: the metadata contract and the software surface are versioned
    // separately, so `metamodel` must not be read off a package line. Today it is `0.13`
    // against npm `0.24.x` — the assertion is that they are not the same fact, which is
    // what a reader needs in order to know a metamodel move did not happen.
    const r = buildPayload(REPO).registries;
    expect(r.metamodel).not.toBe(r.npm);
  });

  test("PyPI and NuGet are read from their own manifests, not copied from npm", () => {
    // Under publish-what-changed (0.24.5) a registry legitimately LAGS: it sits a release
    // out and keeps its number. So the coordinates may differ, and the payload must be
    // able to say so. Deriving pypi/nuget from npm would make a lagging registry
    // unreportable — the page would claim a version that was never published.
    const r = buildPayload(REPO).registries;
    const pypi = /^version\s*=\s*"([^"]+)"/m
      .exec(readFileSync(resolve(REPO, "server/python/pyproject.toml"), "utf8"))?.[1];
    const nuget = /<Version>([^<]+)<\/Version>/
      .exec(readFileSync(resolve(REPO, "server/csharp/Directory.Build.props"), "utf8"))?.[1];
    // Fail closed. An unreadable manifest must not become `undefined === undefined`
    // and pass — that is the assertion asserting nothing.
    if (pypi === undefined || nuget === undefined) {
      throw new Error("could not read the PyPI/NuGet version from its own manifest");
    }
    expect(r.pypi).toBe(pypi);
    expect(r.nuget).toBe(nuget);
  });
});
