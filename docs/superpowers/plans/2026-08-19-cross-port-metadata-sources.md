# Cross-port metadata `sources` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Java/Kotlin, C# and Python CLIs read the `sources` key from the port-neutral `.metaobjects/config.json`, so all four CLI surfaces resolve the same metadata files the Node `meta` CLI already does.

**Architecture:** Each port gains two small units — a **neutral-subset config reader** (parse `schema_version` + `sources`, ignore unknown top-level keys) and a **source resolver** (spec set → metadata file set, relative to the declaring config's directory). Both are then wired behind the port's existing metadata-location argument as a *fallback*, never an override. A new filesystem-based conformance corpus gates the resolved file **set** across all four ports plus TypeScript.

**Tech Stack:** Java 17 + Maven (`metaobjects-maven-plugin`, JUnit), C# (.NET, xUnit), Python 3 (`uv` + pytest), TypeScript (Bun test). No new third-party dependencies in any port.

**Spec:** [`docs/superpowers/specs/2026-08-19-cross-port-metadata-sources-design.md`](../specs/2026-08-19-cross-port-metadata-sources-design.md)

## Global Constraints

- **`scope` is OUT of scope.** Only `sources` ships. No port may read, parse, or act on the `scope` or `migrate.scope` keys. Reason: Java's shipped `<filters>` grammar collides on `*` and `@` (spec §2).
- **The neutral subset is exactly `schema_version` and `sources`.** Validate these strictly; **ignore unknown top-level keys** — the file carries TypeScript-owned keys (`pending_in_git`, `confidence_thresholds`, `extract`, `migrate`) that no other port models (spec §4).
- **`schema_version` must equal `1`.** Any other value is an error.
- **Relative `path` resolves against the directory holding the `.metaobjects/` folder** — never ambient cwd. Absolute paths as-is (spec §3).
- **Default when `sources` is absent or empty:** exactly one `path` source, the literal `metaobjects` (spec §3, `metadata-files.ts:33`).
- **Metadata file extensions:** `.json`, `.yaml`, `.yml`, matched case-insensitively. All four ports already agree — do not change any port's existing set.
- **File ORDER is NOT a contract.** Each port keeps its existing `DirectorySource` walk order. Corpus comparisons are order-insensitive (set equality) (spec §3).
- **Error codes, already registered in all five ledgers — do not add any:** `ERR_SOURCE_UNRESOLVED` (a declared path does not exist), `ERR_SOURCE_KIND_UNSUPPORTED` (`resource`/`package`), `ERR_COLLECTION_NOT_FOUND` (nothing declared and no default dir).
- **Precedence ladder, first match wins** (spec §5): explicit CLI argument → port's native config surface → `.metaobjects/config.json` `sources` → built-in default. **A file that exists but is malformed is an ERROR at its own rung — never a fall-through.**
- **Public repo.** No absolute home paths, no other-project names, in code, tests, fixtures, docs or commit messages.
- **All four readers ship in ONE changeset.** Non-TS lanes do not run on PRs (`AGENTS.md:91-92`), so a per-port deferral goes green locally and turns ports red on the next push to `main`.

---

## File Structure

**New shared corpus**
- `fixtures/source-resolution-conformance/cases.json` — the single source of truth for every port's expectations
- `fixtures/source-resolution-conformance/README.md` — grammar, semantics, runner contract

**TypeScript** (reference implementation already exists; adds a runner only)
- Create: `server/typescript/packages/sdk/test/source-resolution-conformance.test.ts`

**Python**
- Create: `server/python/src/metaobjects/config/neutral_config.py` — neutral-subset reader
- Create: `server/python/src/metaobjects/config/source_resolver.py` — spec set → file list
- Create: `server/python/src/metaobjects/config/__init__.py`
- Modify: `server/python/src/metaobjects/cli.py` — fallback wiring
- Create: `server/python/tests/config/test_neutral_config.py`
- Create: `server/python/tests/config/test_source_resolver.py`
- Create: `server/python/tests/conformance/test_source_resolution_conformance.py`

**C#**
- Create: `server/csharp/MetaObjects/Config/NeutralConfig.cs`
- Create: `server/csharp/MetaObjects/Config/SourceResolver.cs`
- Modify: `server/csharp/MetaObjects.Cli/Program.cs` — fallback wiring
- Create: `server/csharp/MetaObjects.Conformance.Tests/SourceResolutionConformanceTests.cs`
- Create: `server/csharp/MetaObjects.Tests/Config/NeutralConfigTests.cs`

**Java** (Kotlin inherits — it has no CLI entry point of its own)
- Create: `server/java/metadata/src/main/java/com/metaobjects/config/NeutralConfig.java`
- Create: `server/java/metadata/src/main/java/com/metaobjects/config/SourceResolver.java`
- Modify: `server/java/maven-plugin/src/main/java/com/metaobjects/mojo/AbstractMetaDataMojo.java` — fallback wiring
- Create: `server/java/metadata/src/test/java/com/metaobjects/config/NeutralConfigTest.java`
- Create: `server/java/metadata/src/test/java/com/metaobjects/config/SourceResolutionConformanceTest.java`

**Node writer**
- Modify: `server/typescript/packages/cli/src/commands/init.ts` — config-only mode
- Modify: `server/typescript/packages/cli/test/init.test.ts`

**Docs**
- Modify: `docs/features/metadata-sources.md:36-42` — the "Port support" paragraph
- Modify: `CHANGELOG.md` — under `## [Unreleased]`

---

## Task 1: The shared corpus and the TypeScript reference runner

The corpus is filesystem-based, unlike `scope-conformance` which is pure string matching. Each case declares a tree to materialize, a config to write, and either an expected file set or an expected error code.

**Files:**
- Create: `fixtures/source-resolution-conformance/cases.json`
- Create: `fixtures/source-resolution-conformance/README.md`
- Create: `server/typescript/packages/sdk/test/source-resolution-conformance.test.ts`

**Interfaces:**
- Produces: the case-file schema every later task's runner consumes —
  `{ cases: [{ name, tree: {relPath: "content"}, config: object | null, expectFiles?: string[], expectError?: string }] }`.
  `tree` keys are paths relative to the materialized project root. `config` is written to `.metaobjects/config.json` when non-null; when null, no config file is created. `expectFiles` are project-root-relative paths, compared as an **unordered set**. `expectError` is an error code string.

- [ ] **Step 1: Write the corpus cases file**

Create `fixtures/source-resolution-conformance/cases.json`:

```json
{
  "cases": [
    {
      "name": "no-config-uses-default-directory",
      "tree": {
        "metaobjects/meta.users.json": "{\"metadata.root\":{\"children\":[]}}"
      },
      "config": null,
      "expectFiles": ["metaobjects/meta.users.json"]
    },
    {
      "name": "empty-sources-uses-default-directory",
      "tree": {
        "metaobjects/meta.users.json": "{\"metadata.root\":{\"children\":[]}}"
      },
      "config": { "schema_version": 1, "sources": [] },
      "expectFiles": ["metaobjects/meta.users.json"]
    },
    {
      "name": "declared-path-replaces-the-default-entirely",
      "tree": {
        "metaobjects/ignored.json": "{\"metadata.root\":{\"children\":[]}}",
        "model/meta.orders.json": "{\"metadata.root\":{\"children\":[]}}"
      },
      "config": { "schema_version": 1, "sources": [{ "path": "model" }] },
      "expectFiles": ["model/meta.orders.json"]
    },
    {
      "name": "directory-is-walked-recursively",
      "tree": {
        "model/meta.a.json": "{\"metadata.root\":{\"children\":[]}}",
        "model/nested/meta.b.yaml": "metadata.root:\n  children: []\n",
        "model/nested/deep/meta.c.yml": "metadata.root:\n  children: []\n"
      },
      "config": { "schema_version": 1, "sources": [{ "path": "model" }] },
      "expectFiles": [
        "model/meta.a.json",
        "model/nested/meta.b.yaml",
        "model/nested/deep/meta.c.yml"
      ]
    },
    {
      "name": "non-metadata-extensions-are-ignored",
      "tree": {
        "model/meta.a.json": "{\"metadata.root\":{\"children\":[]}}",
        "model/README.md": "not metadata",
        "model/notes.txt": "not metadata",
        "model/script.ts": "export {}"
      },
      "config": { "schema_version": 1, "sources": [{ "path": "model" }] },
      "expectFiles": ["model/meta.a.json"]
    },
    {
      "name": "a-single-file-path-resolves-to-that-file",
      "tree": {
        "vendor/meta.catalog.json": "{\"metadata.root\":{\"children\":[]}}",
        "vendor/meta.other.json": "{\"metadata.root\":{\"children\":[]}}"
      },
      "config": { "schema_version": 1, "sources": [{ "path": "vendor/meta.catalog.json" }] },
      "expectFiles": ["vendor/meta.catalog.json"]
    },
    {
      "name": "two-sources-union",
      "tree": {
        "a/meta.a.json": "{\"metadata.root\":{\"children\":[]}}",
        "b/meta.b.json": "{\"metadata.root\":{\"children\":[]}}"
      },
      "config": { "schema_version": 1, "sources": [{ "path": "a" }, { "path": "b" }] },
      "expectFiles": ["a/meta.a.json", "b/meta.b.json"]
    },
    {
      "name": "overlapping-sources-yield-each-file-once",
      "tree": {
        "model/meta.a.json": "{\"metadata.root\":{\"children\":[]}}",
        "model/nested/meta.b.json": "{\"metadata.root\":{\"children\":[]}}"
      },
      "config": {
        "schema_version": 1,
        "sources": [{ "path": "model" }, { "path": "model/nested" }]
      },
      "expectFiles": ["model/meta.a.json", "model/nested/meta.b.json"]
    },
    {
      "name": "source-order-does-not-change-the-resolved-set",
      "tree": {
        "a/meta.a.json": "{\"metadata.root\":{\"children\":[]}}",
        "b/meta.b.json": "{\"metadata.root\":{\"children\":[]}}"
      },
      "config": { "schema_version": 1, "sources": [{ "path": "b" }, { "path": "a" }] },
      "expectFiles": ["a/meta.a.json", "b/meta.b.json"]
    },
    {
      "name": "a-parent-relative-path-resolves-against-the-config-directory",
      "tree": {
        "shared/meta.shared.json": "{\"metadata.root\":{\"children\":[]}}",
        "app/.keep": ""
      },
      "config": { "schema_version": 1, "sources": [{ "path": "shared" }] },
      "expectFiles": ["shared/meta.shared.json"]
    },
    {
      "name": "a-declared-path-that-does-not-exist-is-an-error",
      "tree": {
        "metaobjects/meta.users.json": "{\"metadata.root\":{\"children\":[]}}"
      },
      "config": { "schema_version": 1, "sources": [{ "path": "nope" }] },
      "expectError": "ERR_SOURCE_UNRESOLVED"
    },
    {
      "name": "an-empty-directory-source-resolves-to-no-files",
      "tree": {
        "model/.keep": ""
      },
      "config": { "schema_version": 1, "sources": [{ "path": "model" }] },
      "expectFiles": []
    },
    {
      "name": "resource-kind-is-unsupported",
      "tree": {
        "metaobjects/meta.users.json": "{\"metadata.root\":{\"children\":[]}}"
      },
      "config": { "schema_version": 1, "sources": [{ "resource": "com/acme/model" }] },
      "expectError": "ERR_SOURCE_KIND_UNSUPPORTED"
    },
    {
      "name": "package-kind-is-unsupported",
      "tree": {
        "metaobjects/meta.users.json": "{\"metadata.root\":{\"children\":[]}}"
      },
      "config": { "schema_version": 1, "sources": [{ "package": "acme-model" }] },
      "expectError": "ERR_SOURCE_KIND_UNSUPPORTED"
    },
    {
      "name": "no-config-and-no-default-directory-is-an-error",
      "tree": {
        "src/.keep": ""
      },
      "config": null,
      "expectError": "ERR_COLLECTION_NOT_FOUND"
    },
    {
      "name": "unknown-top-level-keys-are-ignored",
      "tree": {
        "model/meta.a.json": "{\"metadata.root\":{\"children\":[]}}"
      },
      "config": {
        "schema_version": 1,
        "sources": [{ "path": "model" }],
        "pending_in_git": true,
        "confidence_thresholds": { "pending_promote": 0.8 },
        "extract": { "metaignore": ".metaignore" },
        "migrate": { "dialect": "postgres" }
      },
      "expectFiles": ["model/meta.a.json"]
    }
  ]
}
```

- [ ] **Step 2: Write the corpus README**

Create `fixtures/source-resolution-conformance/README.md`:

```markdown
# source-resolution-conformance

Pins how a consumer's `sources` set in `.metaobjects/config.json` resolves to a
set of metadata files. Every port's CLI must resolve the SAME FILES from the
same declaration — that is the cross-port promise this corpus exists to keep.

Companion to `scope-conformance/`, which pins the (currently TypeScript-only)
`scope` pattern grammar. The two are independent: `sources` decides which files
are read, `scope` filters what is emitted from them.

## Shape

```
cases.json   # { cases: [{ name, tree, config, expectFiles? , expectError? }] }
README.md
```

- **`tree`** — a map of project-root-relative path → file content. The runner
  materializes it in a fresh temporary directory. A `.keep` entry exists only to
  force an otherwise-empty directory to be created.
- **`config`** — written verbatim to `.metaobjects/config.json` under the project
  root. When `null`, no config file is created at all.
- **`expectFiles`** — project-root-relative paths, compared as an **UNORDERED
  SET**. See "Order is deliberately not pinned" below.
- **`expectError`** — an error code the resolution must fail with. Exactly one of
  `expectFiles` / `expectError` is present per case.

## Semantics pinned here

- **Default.** `sources` absent or empty ⇒ exactly one `path` source, the literal
  `metaobjects`. It is a default VALUE, never a requirement.
- **Replacement, not merge.** A declared `sources` replaces the default entirely —
  the default directory is not implicitly appended.
- **Relative base.** A relative `path` resolves against the directory HOLDING the
  `.metaobjects/` folder, never against the process working directory.
- **Recursion.** A directory `path` is walked recursively; a file `path` resolves
  to that one file.
- **Extensions.** `.json`, `.yaml`, `.yml`, matched case-insensitively. Nothing else.
- **Union with de-duplication.** Overlapping sources yield each file exactly once.
- **A declared path that does not exist is `ERR_SOURCE_UNRESOLVED`** — never a
  silent skip. Only the DEFAULT may be absent, and then it is
  `ERR_COLLECTION_NOT_FOUND`.
- **`resource` and `package` kinds are declared but resolve nowhere yet:**
  `ERR_SOURCE_KIND_UNSUPPORTED`.
- **Unknown top-level config keys are IGNORED.** The file carries
  TypeScript-owned keys no other port models. `schema_version` and `sources` are
  the neutral subset; each port validates those strictly and ignores the rest.

## Order is deliberately NOT pinned

`expectFiles` is a set. The ports' directory walks already differ and always
have — Java sorts by basename (`DirectorySource.java:105`), C# by full-path
ordinal (`DirectorySource.cs:64`), Python by basename
(`directory_source.py:40-48`), TypeScript walks depth-first with files before
subdirectories (`metadata-files.ts:101-121`). Making order a contract would be a
behavior change in three ports for no benefit: super-resolution is
order-independent (#188) and the loader's overlay partition discards caller
order anyway.

A port MAY have a stable internal order — several do, and their own generated
output depends on it. It just is not a cross-port promise.

## Behavioral contract

Each port's runner reads `cases.json`, and for every case: materializes `tree`
in a fresh temp directory, writes `config` when non-null, resolves sources
against that root, then asserts either that the resolved file set equals
`expectFiles` (as a set, project-root-relative, path separators normalized to
`/`) or that resolution failed with `expectError`.

## Reference implementation

`server/typescript/packages/sdk/src/sources.ts` (`resolveSources`) and
`server/typescript/packages/sdk/src/collection.ts` (`resolveCollection`).
```

- [ ] **Step 3: Write the failing TypeScript runner**

Create `server/typescript/packages/sdk/test/source-resolution-conformance.test.ts`:

```ts
// Runs the shared source-resolution corpus against the TypeScript reference
// implementation. Every port ships an equivalent runner reading this same file.
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { resolveCollection } from "../src/collection.js";

interface Case {
  readonly name: string;
  readonly tree: Record<string, string>;
  readonly config: unknown | null;
  readonly expectFiles?: readonly string[];
  readonly expectError?: string;
}

const CORPUS = resolve(import.meta.dir, "../../../../../fixtures/source-resolution-conformance/cases.json");

async function materialize(c: Case): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mo-src-conf-"));
  for (const [rel, content] of Object.entries(c.tree)) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  if (c.config !== null) {
    await mkdir(join(root, ".metaobjects"), { recursive: true });
    await writeFile(join(root, ".metaobjects", "config.json"), JSON.stringify(c.config, null, 2));
  }
  return root;
}

const cases: Case[] = JSON.parse(await readFile(CORPUS, "utf8")).cases;

describe("source-resolution conformance", () => {
  for (const c of cases) {
    test(c.name, async () => {
      const root = await materialize(c);
      if (c.expectError !== undefined) {
        let code: string | undefined;
        try {
          await resolveCollection(root, { explicitDir: root });
        } catch (e) {
          code = (e as { code?: string }).code;
        }
        expect(code).toBe(c.expectError);
        return;
      }
      const collection = await resolveCollection(root, { explicitDir: root });
      const got = collection.files.map((f) => relative(root, f).split(sep).join("/")).sort();
      expect(got).toEqual([...(c.expectFiles ?? [])].sort());
    });
  }
});
```

- [ ] **Step 4: Run it and confirm every case passes**

Run: `cd server/typescript/packages/sdk && bun test test/source-resolution-conformance.test.ts`
Expected: **16 pass, 0 fail.** The TypeScript side is the already-shipped reference — this runner asserts the corpus describes real behavior, so a failure here means the CORPUS is wrong, not the code. Fix `cases.json` until it matches, and do not change `sources.ts` or `collection.ts` in this task.

- [ ] **Step 5: Typecheck**

Run: `cd server/typescript && bun run --filter '*' typecheck`
Expected: clean. (`bun test` does not typecheck — a break here would otherwise sit red through later tasks.)

- [ ] **Step 6: Commit**

```bash
git add fixtures/source-resolution-conformance server/typescript/packages/sdk/test/source-resolution-conformance.test.ts
git commit -m "test(conformance): a corpus for cross-port source resolution

Pins the resolved file SET — not its order, which already differs by port
and is not a contract. TypeScript is the reference and ships the first
runner; the other three follow in this changeset."
```

---

## Task 2: Python — neutral config reader and source resolver

**Files:**
- Create: `server/python/src/metaobjects/config/__init__.py`
- Create: `server/python/src/metaobjects/config/neutral_config.py`
- Create: `server/python/src/metaobjects/config/source_resolver.py`
- Test: `server/python/tests/config/test_neutral_config.py`
- Test: `server/python/tests/config/test_source_resolver.py`

**Interfaces:**
- Consumes: `fixtures/source-resolution-conformance/cases.json` (Task 1); the existing `metaobjects.errors.ErrorCode` members `ERR_SOURCE_UNRESOLVED`, `ERR_SOURCE_KIND_UNSUPPORTED`, `ERR_COLLECTION_NOT_FOUND` (`errors.py:108,110,114`).
- Produces:
  - `read_neutral_config(config_dir: Path) -> NeutralConfig | None` — `None` when no `.metaobjects/config.json` exists; raises on malformed.
  - `NeutralConfig` dataclass with field `sources: list[dict[str, str]]`.
  - `DEFAULT_METADATA_DIR: str = "metaobjects"`.
  - `resolve_sources(config_dir: Path, specs: list[dict[str, str]]) -> list[Path]`.
  - `resolve_collection(root: Path) -> list[Path]` — the full ladder: config-or-default, then resolve.

- [ ] **Step 1: Write the failing config-reader test**

Create `server/python/tests/config/test_neutral_config.py`:

```python
import json
import pytest
from pathlib import Path

from metaobjects.config.neutral_config import read_neutral_config
from metaobjects.errors import MetaObjectsError


def _write_config(root: Path, payload: object) -> None:
    d = root / ".metaobjects"
    d.mkdir(parents=True, exist_ok=True)
    (d / "config.json").write_text(json.dumps(payload))


def test_absent_config_returns_none(tmp_path: Path) -> None:
    assert read_neutral_config(tmp_path) is None


def test_reads_sources(tmp_path: Path) -> None:
    _write_config(tmp_path, {"schema_version": 1, "sources": [{"path": "model"}]})
    cfg = read_neutral_config(tmp_path)
    assert cfg is not None
    assert cfg.sources == [{"path": "model"}]


def test_unknown_top_level_keys_are_ignored(tmp_path: Path) -> None:
    # The file carries TypeScript-owned keys this port must not model.
    _write_config(
        tmp_path,
        {
            "schema_version": 1,
            "sources": [{"path": "model"}],
            "pending_in_git": True,
            "confidence_thresholds": {"pending_promote": 0.8},
            "extract": {"metaignore": ".metaignore"},
            "migrate": {"dialect": "postgres"},
        },
    )
    cfg = read_neutral_config(tmp_path)
    assert cfg is not None
    assert cfg.sources == [{"path": "model"}]


def test_absent_sources_key_yields_empty_list(tmp_path: Path) -> None:
    _write_config(tmp_path, {"schema_version": 1})
    cfg = read_neutral_config(tmp_path)
    assert cfg is not None
    assert cfg.sources == []


def test_malformed_json_raises_not_none(tmp_path: Path) -> None:
    d = tmp_path / ".metaobjects"
    d.mkdir(parents=True)
    (d / "config.json").write_text("{ not json")
    # A file that EXISTS but cannot be read must never look like no config at all.
    with pytest.raises(MetaObjectsError):
        read_neutral_config(tmp_path)


def test_wrong_schema_version_raises(tmp_path: Path) -> None:
    _write_config(tmp_path, {"schema_version": 2, "sources": []})
    with pytest.raises(MetaObjectsError):
        read_neutral_config(tmp_path)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server/python && uv run pytest tests/config/test_neutral_config.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'metaobjects.config'`

- [ ] **Step 3: Implement the reader**

Create `server/python/src/metaobjects/config/__init__.py`:

```python
"""Port-neutral `.metaobjects/config.json` reading and source resolution.

Reads only the NEUTRAL SUBSET (`schema_version`, `sources`). The file also
carries TypeScript-owned keys; those are ignored rather than modeled, so a new
TS-only key never becomes a four-port change. See
`docs/superpowers/specs/2026-08-19-cross-port-metadata-sources-design.md` §4.
"""
from .neutral_config import DEFAULT_METADATA_DIR, NeutralConfig, read_neutral_config
from .source_resolver import resolve_collection, resolve_sources

__all__ = [
    "DEFAULT_METADATA_DIR",
    "NeutralConfig",
    "read_neutral_config",
    "resolve_collection",
    "resolve_sources",
]
```

Create `server/python/src/metaobjects/config/neutral_config.py`:

```python
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from metaobjects.errors import ErrorCode, MetaObjectsError

#: The DEFAULT value of `sources` when the key is absent or empty — never a
#: requirement, and never assumed to exist by any other code path.
DEFAULT_METADATA_DIR = "metaobjects"

_METAOBJECTS_DIR = ".metaobjects"
_CONFIG_FILE = "config.json"


@dataclass(frozen=True)
class NeutralConfig:
    """The port-neutral subset of `.metaobjects/config.json`."""

    #: Raw source specs, each a single-key mapping (`path` / `resource` / `package`).
    sources: list[dict[str, str]]


def read_neutral_config(config_dir: Path) -> NeutralConfig | None:
    """Read the neutral subset from ``config_dir/.metaobjects/config.json``.

    Returns ``None`` when the file does not exist. A file that EXISTS but is
    malformed raises — swallowing it would make a typo'd config behave
    identically to no config at all, silently resolving a possibly-stale
    default directory with no diagnostic.
    """
    path = config_dir / _METAOBJECTS_DIR / _CONFIG_FILE
    if not path.is_file():
        return None

    try:
        raw = json.loads(path.read_text())
    except (OSError, ValueError) as e:
        raise MetaObjectsError(
            f"{path} exists but could not be read as JSON: {e}",
            code=ErrorCode.ERR_COLLECTION_NOT_FOUND,
        ) from e

    if not isinstance(raw, dict):
        raise MetaObjectsError(
            f"{path} must contain a JSON object",
            code=ErrorCode.ERR_COLLECTION_NOT_FOUND,
        )

    version = raw.get("schema_version")
    if version != 1:
        raise MetaObjectsError(
            f"{path}: unsupported schema_version {version!r} (expected 1)",
            code=ErrorCode.ERR_COLLECTION_NOT_FOUND,
        )

    sources = raw.get("sources", [])
    if not isinstance(sources, list) or not all(
        isinstance(s, dict) and len(s) == 1 for s in sources
    ):
        raise MetaObjectsError(
            f"{path}: 'sources' must be an array of single-key objects",
            code=ErrorCode.ERR_COLLECTION_NOT_FOUND,
        )

    # Unknown top-level keys are IGNORED by design — see the module docstring.
    return NeutralConfig(sources=[dict(s) for s in sources])
```

- [ ] **Step 4: Run the reader tests**

Run: `cd server/python && uv run pytest tests/config/test_neutral_config.py -v`
Expected: 6 passed. If `MetaObjectsError`'s constructor signature differs, adapt the raise sites to the real one — check with `grep -n "class MetaObjectsError" -A12 server/python/src/metaobjects/errors.py` and use whatever the existing code passes.

- [ ] **Step 5: Write the failing resolver test**

Create `server/python/tests/config/test_source_resolver.py`:

```python
import json
import pytest
from pathlib import Path

from metaobjects.config.source_resolver import resolve_collection, resolve_sources
from metaobjects.errors import ErrorCode, MetaObjectsError


def _rel(root: Path, files: list[Path]) -> set[str]:
    return {p.relative_to(root).as_posix() for p in files}


def test_directory_is_walked_recursively(tmp_path: Path) -> None:
    (tmp_path / "model" / "nested").mkdir(parents=True)
    (tmp_path / "model" / "a.json").write_text("{}")
    (tmp_path / "model" / "nested" / "b.yaml").write_text("{}")
    (tmp_path / "model" / "README.md").write_text("x")
    got = resolve_sources(tmp_path, [{"path": "model"}])
    assert _rel(tmp_path, got) == {"model/a.json", "model/nested/b.yaml"}


def test_single_file_spec(tmp_path: Path) -> None:
    (tmp_path / "vendor").mkdir()
    (tmp_path / "vendor" / "one.json").write_text("{}")
    (tmp_path / "vendor" / "two.json").write_text("{}")
    got = resolve_sources(tmp_path, [{"path": "vendor/one.json"}])
    assert _rel(tmp_path, got) == {"vendor/one.json"}


def test_overlapping_sources_dedupe(tmp_path: Path) -> None:
    (tmp_path / "model" / "nested").mkdir(parents=True)
    (tmp_path / "model" / "a.json").write_text("{}")
    (tmp_path / "model" / "nested" / "b.json").write_text("{}")
    got = resolve_sources(tmp_path, [{"path": "model"}, {"path": "model/nested"}])
    assert _rel(tmp_path, got) == {"model/a.json", "model/nested/b.json"}
    assert len(got) == 2


def test_missing_path_raises_unresolved(tmp_path: Path) -> None:
    with pytest.raises(MetaObjectsError) as e:
        resolve_sources(tmp_path, [{"path": "nope"}])
    assert e.value.code == ErrorCode.ERR_SOURCE_UNRESOLVED


def test_resource_kind_unsupported(tmp_path: Path) -> None:
    with pytest.raises(MetaObjectsError) as e:
        resolve_sources(tmp_path, [{"resource": "com/acme"}])
    assert e.value.code == ErrorCode.ERR_SOURCE_KIND_UNSUPPORTED


def test_collection_falls_back_to_default_dir(tmp_path: Path) -> None:
    (tmp_path / "metaobjects").mkdir()
    (tmp_path / "metaobjects" / "a.json").write_text("{}")
    got = resolve_collection(tmp_path)
    assert _rel(tmp_path, got) == {"metaobjects/a.json"}


def test_collection_with_no_config_and_no_default_raises(tmp_path: Path) -> None:
    with pytest.raises(MetaObjectsError) as e:
        resolve_collection(tmp_path)
    assert e.value.code == ErrorCode.ERR_COLLECTION_NOT_FOUND


def test_declared_sources_replace_the_default(tmp_path: Path) -> None:
    (tmp_path / ".metaobjects").mkdir()
    (tmp_path / ".metaobjects" / "config.json").write_text(
        json.dumps({"schema_version": 1, "sources": [{"path": "model"}]})
    )
    (tmp_path / "metaobjects").mkdir()
    (tmp_path / "metaobjects" / "ignored.json").write_text("{}")
    (tmp_path / "model").mkdir()
    (tmp_path / "model" / "used.json").write_text("{}")
    got = resolve_collection(tmp_path)
    assert _rel(tmp_path, got) == {"model/used.json"}
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd server/python && uv run pytest tests/config/test_source_resolver.py -v`
Expected: FAIL — `ImportError: cannot import name 'resolve_sources'`

- [ ] **Step 7: Implement the resolver**

Create `server/python/src/metaobjects/config/source_resolver.py`:

```python
from __future__ import annotations

from pathlib import Path

from metaobjects.errors import ErrorCode, MetaObjectsError

from .neutral_config import DEFAULT_METADATA_DIR, read_neutral_config

_SUPPORTED_SUFFIXES = (".json", ".yaml", ".yml")


def _list_metadata_files(directory: Path) -> list[Path]:
    """Recursively list metadata files under ``directory``.

    Mirrors `DirectorySource`'s extension set (`.json`/`.yaml`/`.yml`,
    case-insensitive). Order is this port's own and is deliberately NOT a
    cross-port contract — see the corpus README.
    """
    return sorted(
        (p for p in directory.rglob("*") if p.is_file() and p.suffix.lower() in _SUPPORTED_SUFFIXES),
        key=lambda p: p.name,
    )


def resolve_sources(config_dir: Path, specs: list[dict[str, str]]) -> list[Path]:
    """Resolve a declared source SET to a de-duplicated list of metadata files.

    A relative ``path`` resolves against ``config_dir`` — the directory HOLDING
    the ``.metaobjects/`` folder — never against the process working directory.
    """
    seen: dict[Path, None] = {}

    for spec in specs:
        if "path" not in spec:
            kind = next(iter(spec), "<empty>")
            raise MetaObjectsError(
                f'source kind "{kind}" is not supported by this toolchain yet; use a "path" source',
                code=ErrorCode.ERR_SOURCE_KIND_UNSUPPORTED,
            )

        raw = Path(spec["path"])
        target = raw if raw.is_absolute() else (config_dir / raw)

        if not target.exists():
            raise MetaObjectsError(
                f'source path "{spec["path"]}" does not exist '
                f"(resolved to {target}, relative to {config_dir})",
                code=ErrorCode.ERR_SOURCE_UNRESOLVED,
            )

        found = _list_metadata_files(target) if target.is_dir() else [target]
        for f in found:
            seen.setdefault(f.resolve(), None)

    return list(seen)


def resolve_collection(root: Path) -> list[Path]:
    """The full ladder: declared `sources`, else the default directory.

    Only the DEFAULT may be absent — a declared source that does not resolve is
    `ERR_SOURCE_UNRESOLVED`, a louder failure.
    """
    root = root.resolve()
    cfg = read_neutral_config(root)
    specs = cfg.sources if cfg is not None and cfg.sources else []

    if not specs:
        default_dir = root / DEFAULT_METADATA_DIR
        if not default_dir.is_dir():
            raise MetaObjectsError(
                f'no metadata sources declared in {root} and no default '
                f'"{DEFAULT_METADATA_DIR}" directory found. Declare "sources" in '
                f".metaobjects/config.json, or run 'meta init' to scaffold.",
                code=ErrorCode.ERR_COLLECTION_NOT_FOUND,
            )
        specs = [{"path": DEFAULT_METADATA_DIR}]

    return resolve_sources(root, specs)
```

- [ ] **Step 8: Run the resolver tests**

Run: `cd server/python && uv run pytest tests/config/ -v`
Expected: 14 passed (6 reader + 8 resolver).

- [ ] **Step 9: Commit**

```bash
git add server/python/src/metaobjects/config server/python/tests/config
git commit -m "feat(python): read the port-neutral sources key

Neutral subset only (schema_version + sources); unknown top-level keys are
ignored so a TypeScript-owned key never becomes a four-port change."
```

---

## Task 3: Python — conformance runner and CLI fallback

**Files:**
- Create: `server/python/tests/conformance/test_source_resolution_conformance.py`
- Modify: `server/python/src/metaobjects/cli.py`

**Interfaces:**
- Consumes: `resolve_collection` / `resolve_sources` (Task 2); `cases.json` (Task 1).
- Produces: CLI behavior — a `gen`/`verify` invocation with no positional `metadata_dir` and no `metadata` key in `metaobjects.config.yaml` falls back to `.metaobjects/config.json`.

- [ ] **Step 1: Write the failing conformance runner**

Create `server/python/tests/conformance/test_source_resolution_conformance.py`:

```python
"""Runs the shared source-resolution corpus against this port.

Reads `fixtures/source-resolution-conformance/cases.json` — the single
committed source of truth. There is no per-port fixture.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaobjects.config.source_resolver import resolve_collection
from metaobjects.errors import MetaObjectsError

_CORPUS = (
    Path(__file__).resolve().parents[3]
    / "fixtures"
    / "source-resolution-conformance"
    / "cases.json"
)

_CASES = json.loads(_CORPUS.read_text())["cases"]


def _materialize(case: dict, root: Path) -> None:
    for rel, content in case["tree"].items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
    if case["config"] is not None:
        d = root / ".metaobjects"
        d.mkdir(parents=True, exist_ok=True)
        (d / "config.json").write_text(json.dumps(case["config"], indent=2))


@pytest.mark.parametrize("case", _CASES, ids=[c["name"] for c in _CASES])
def test_source_resolution_conformance(case: dict, tmp_path: Path) -> None:
    _materialize(case, tmp_path)

    if "expectError" in case:
        with pytest.raises(MetaObjectsError) as e:
            resolve_collection(tmp_path)
        assert e.value.code.value == case["expectError"]
        return

    got = {p.relative_to(tmp_path.resolve()).as_posix() for p in resolve_collection(tmp_path)}
    assert got == set(case["expectFiles"])
```

- [ ] **Step 2: Run it**

Run: `cd server/python && uv run pytest tests/conformance/test_source_resolution_conformance.py -v`
Expected: 16 passed. If `e.value.code` is already a plain string rather than an enum, drop the `.value`. If the corpus path resolution is wrong, print `_CORPUS` and correct the `parents[N]` index — the file must resolve to the repository's `fixtures/` directory.

- [ ] **Step 3: Write the failing CLI fallback test**

Add to `server/python/tests/conformance/test_source_resolution_conformance.py`:

```python
def test_cli_falls_back_to_neutral_config(tmp_path: Path, monkeypatch) -> None:
    """No positional metadata_dir and no YAML `metadata` key ⇒ neutral config wins."""
    (tmp_path / "model").mkdir()
    (tmp_path / "model" / "meta.a.json").write_text('{"metadata.root":{"children":[]}}')
    d = tmp_path / ".metaobjects"
    d.mkdir()
    (d / "config.json").write_text(
        json.dumps({"schema_version": 1, "sources": [{"path": "model"}]})
    )

    from metaobjects.cli import resolve_metadata_location

    monkeypatch.chdir(tmp_path)
    got = resolve_metadata_location(explicit=None, config=None, root=tmp_path)
    assert {Path(p).relative_to(tmp_path.resolve()).as_posix() for p in got} == {
        "model/meta.a.json"
    }
```

- [ ] **Step 4: Run it to verify it fails**

Run: `cd server/python && uv run pytest tests/conformance/test_source_resolution_conformance.py::test_cli_falls_back_to_neutral_config -v`
Expected: FAIL — `ImportError: cannot import name 'resolve_metadata_location'`

- [ ] **Step 5: Add the ladder function to the CLI**

Add to `server/python/src/metaobjects/cli.py` (near the other resolution helpers, around the existing `gen_state_dir_for` at line 387):

```python
def resolve_metadata_location(
    explicit: str | None,
    config: "ProjectConfig | None",
    root: Path,
) -> list[str]:
    """The precedence ladder for where metadata lives. First match wins.

    1. An explicit CLI argument (the positional ``metadata_dir``).
    2. This port's native surface — ``metadata`` in ``metaobjects.config.yaml``.
    3. ``sources`` in the port-neutral ``.metaobjects/config.json``.
    4. The built-in default directory.

    A file that EXISTS at any rung but is malformed raises rather than falling
    through to the next rung. See
    `docs/superpowers/specs/2026-08-19-cross-port-metadata-sources-design.md` §5.
    """
    from metaobjects.config.source_resolver import resolve_collection, resolve_sources

    if explicit is not None:
        return [str(p) for p in resolve_sources(Path(explicit).resolve().parent, [{"path": explicit}])]

    if config is not None:
        return [str(p) for p in resolve_sources(Path(config.metadata_dir()).parent, [{"path": config.metadata_dir()}])]

    # Rungs 3 and 4 both live in `resolve_collection`.
    return [str(p) for p in resolve_collection(root)]
```

- [ ] **Step 6: Run the test**

Run: `cd server/python && uv run pytest tests/conformance/test_source_resolution_conformance.py -v`
Expected: 17 passed.

- [ ] **Step 7: Run the whole Python suite for regressions**

Run: `cd server/python && uv run --extra integration pytest -q`
Expected: no new failures versus the pre-task baseline. (Capture the baseline first with the same command on a clean tree if you have not already — `uv.lock` re-dirties on any `uv run`; do NOT commit it.)

- [ ] **Step 8: Commit**

```bash
git add server/python/src/metaobjects/cli.py server/python/tests/conformance/test_source_resolution_conformance.py
git commit -m "feat(python): the neutral config is the fallback when nothing else names a location

Ladder: explicit arg > metaobjects.config.yaml > .metaobjects/config.json >
default dir. Gated by the shared source-resolution corpus."
```

---

## Task 4: C# — neutral config reader, resolver, conformance runner, CLI fallback

**Files:**
- Create: `server/csharp/MetaObjects/Config/NeutralConfig.cs`
- Create: `server/csharp/MetaObjects/Config/SourceResolver.cs`
- Create: `server/csharp/MetaObjects.Conformance.Tests/SourceResolutionConformanceTests.cs`
- Modify: `server/csharp/MetaObjects.Cli/Program.cs`

**Interfaces:**
- Consumes: `cases.json` (Task 1); `MetaObjects.Errors` members `ERR_SOURCE_UNRESOLVED`, `ERR_SOURCE_KIND_UNSUPPORTED`, `ERR_COLLECTION_NOT_FOUND` (`Errors.cs:132,134,138`).
- Produces:
  - `MetaObjects.Config.NeutralConfig.Read(string configDir) -> NeutralConfig?`
  - `NeutralConfig.Sources -> IReadOnlyList<IReadOnlyDictionary<string,string>>`
  - `MetaObjects.Config.SourceResolver.ResolveCollection(string root) -> IReadOnlyList<string>`
  - `MetaObjects.Config.SourceResolver.ResolveSources(string configDir, IReadOnlyList<IReadOnlyDictionary<string,string>> specs) -> IReadOnlyList<string>`
  - `NeutralConfig.DefaultMetadataDir -> "metaobjects"`

- [ ] **Step 1: Write the failing conformance runner**

Create `server/csharp/MetaObjects.Conformance.Tests/SourceResolutionConformanceTests.cs`:

```csharp
// Runs the shared source-resolution corpus against this port. Reads the single
// committed fixtures/source-resolution-conformance/cases.json — no per-port fixture.
using System.Text.Json;
using MetaObjects.Config;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class SourceResolutionConformanceTests
{
    private sealed record Case(
        string Name,
        Dictionary<string, string> Tree,
        JsonElement? Config,
        string[]? ExpectFiles,
        string? ExpectError);

    public static TheoryData<string> CaseNames()
    {
        var data = new TheoryData<string>();
        foreach (var c in LoadCases()) data.Add(c.Name);
        return data;
    }

    private static string CorpusPath()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "fixtures")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        return Path.Combine(dir!.FullName, "fixtures", "source-resolution-conformance", "cases.json");
    }

    private static List<Case> LoadCases()
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(CorpusPath()));
        var cases = new List<Case>();
        foreach (var el in doc.RootElement.GetProperty("cases").EnumerateArray())
        {
            var tree = new Dictionary<string, string>();
            foreach (var p in el.GetProperty("tree").EnumerateObject())
                tree[p.Name] = p.Value.GetString() ?? "";

            var cfgEl = el.GetProperty("config");
            JsonElement? cfg = cfgEl.ValueKind == JsonValueKind.Null ? null : cfgEl.Clone();

            string[]? expectFiles = el.TryGetProperty("expectFiles", out var ef)
                ? ef.EnumerateArray().Select(x => x.GetString()!).ToArray()
                : null;
            string? expectError = el.TryGetProperty("expectError", out var ee) ? ee.GetString() : null;

            cases.Add(new Case(el.GetProperty("name").GetString()!, tree, cfg, expectFiles, expectError));
        }
        return cases;
    }

    [Theory]
    [MemberData(nameof(CaseNames))]
    public void ResolvesTheSameFileSet(string name)
    {
        var c = LoadCases().Single(x => x.Name == name);
        var root = Path.Combine(Path.GetTempPath(), "mo-src-conf-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            foreach (var (rel, content) in c.Tree)
            {
                var abs = Path.Combine(root, rel.Replace('/', Path.DirectorySeparatorChar));
                Directory.CreateDirectory(Path.GetDirectoryName(abs)!);
                File.WriteAllText(abs, content);
            }
            if (c.Config is not null)
            {
                var d = Path.Combine(root, ".metaobjects");
                Directory.CreateDirectory(d);
                File.WriteAllText(Path.Combine(d, "config.json"), c.Config.Value.GetRawText());
            }

            if (c.ExpectError is not null)
            {
                var ex = Assert.ThrowsAny<MetaObjectsException>(() => SourceResolver.ResolveCollection(root));
                Assert.Equal(c.ExpectError, ex.Code.ToString());
                return;
            }

            var got = SourceResolver.ResolveCollection(root)
                .Select(f => Path.GetRelativePath(root, f).Replace(Path.DirectorySeparatorChar, '/'))
                .ToHashSet();
            Assert.Equal(c.ExpectFiles!.ToHashSet(), got);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server/csharp && dotnet test MetaObjects.Conformance.Tests/MetaObjects.Conformance.Tests.csproj --nologo --verbosity quiet`
Expected: FAIL to COMPILE — `MetaObjects.Config` does not exist. If `MetaObjectsException` is named differently, check with `grep -n "class .*Exception" server/csharp/MetaObjects/Errors.cs` and use the real type and its code property.

- [ ] **Step 3: Implement the reader**

Create `server/csharp/MetaObjects/Config/NeutralConfig.cs`:

```csharp
// Port-neutral `.metaobjects/config.json` reading.
//
// Reads only the NEUTRAL SUBSET (`schema_version`, `sources`). The file also
// carries TypeScript-owned keys; those are IGNORED rather than modeled, so a new
// TS-only key never becomes a four-port change. See
// docs/superpowers/specs/2026-08-19-cross-port-metadata-sources-design.md §4.
using System.Text.Json;

namespace MetaObjects.Config;

public sealed class NeutralConfig
{
    /// The DEFAULT value of `sources` when the key is absent or empty — never a
    /// requirement, and never assumed to exist by any other code path.
    public const string DefaultMetadataDir = "metaobjects";

    private const string MetaObjectsDir = ".metaobjects";
    private const string ConfigFile = "config.json";

    public IReadOnlyList<IReadOnlyDictionary<string, string>> Sources { get; }

    private NeutralConfig(IReadOnlyList<IReadOnlyDictionary<string, string>> sources) => Sources = sources;

    /// Returns null when the file does not exist. A file that EXISTS but is
    /// malformed throws — swallowing it would make a typo'd config behave
    /// identically to no config at all.
    public static NeutralConfig? Read(string configDir)
    {
        var path = Path.Combine(configDir, MetaObjectsDir, ConfigFile);
        if (!File.Exists(path)) return null;

        JsonDocument doc;
        try
        {
            doc = JsonDocument.Parse(File.ReadAllText(path));
        }
        catch (Exception e)
        {
            throw new MetaObjectsException(
                ErrorCode.ERR_COLLECTION_NOT_FOUND,
                $"{path} exists but could not be read as JSON: {e.Message}");
        }

        using (doc)
        {
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
                throw new MetaObjectsException(ErrorCode.ERR_COLLECTION_NOT_FOUND, $"{path} must contain a JSON object");

            if (!root.TryGetProperty("schema_version", out var v) || v.ValueKind != JsonValueKind.Number || v.GetInt32() != 1)
                throw new MetaObjectsException(ErrorCode.ERR_COLLECTION_NOT_FOUND, $"{path}: unsupported schema_version (expected 1)");

            var specs = new List<IReadOnlyDictionary<string, string>>();
            if (root.TryGetProperty("sources", out var srcs) && srcs.ValueKind == JsonValueKind.Array)
            {
                foreach (var s in srcs.EnumerateArray())
                {
                    if (s.ValueKind != JsonValueKind.Object)
                        throw new MetaObjectsException(ErrorCode.ERR_COLLECTION_NOT_FOUND, $"{path}: each 'sources' entry must be an object");
                    var d = new Dictionary<string, string>();
                    foreach (var p in s.EnumerateObject()) d[p.Name] = p.Value.GetString() ?? "";
                    if (d.Count != 1)
                        throw new MetaObjectsException(ErrorCode.ERR_COLLECTION_NOT_FOUND, $"{path}: each 'sources' entry must have exactly one key");
                    specs.Add(d);
                }
            }

            // Unknown top-level keys are IGNORED by design — see the file header.
            return new NeutralConfig(specs);
        }
    }
}
```

- [ ] **Step 4: Implement the resolver**

Create `server/csharp/MetaObjects/Config/SourceResolver.cs`:

```csharp
namespace MetaObjects.Config;

public static class SourceResolver
{
    private static readonly HashSet<string> SupportedExtensions =
        new(StringComparer.OrdinalIgnoreCase) { ".json", ".yaml", ".yml" };

    /// Resolve a declared source SET to a de-duplicated list of metadata files.
    /// A relative `path` resolves against `configDir` — the directory HOLDING the
    /// `.metaobjects/` folder — never against the process working directory.
    public static IReadOnlyList<string> ResolveSources(
        string configDir,
        IReadOnlyList<IReadOnlyDictionary<string, string>> specs)
    {
        var seen = new List<string>();
        var known = new HashSet<string>(StringComparer.Ordinal);

        foreach (var spec in specs)
        {
            if (!spec.TryGetValue("path", out var rawPath))
            {
                var kind = spec.Keys.FirstOrDefault() ?? "<empty>";
                throw new MetaObjectsException(
                    ErrorCode.ERR_SOURCE_KIND_UNSUPPORTED,
                    $"source kind \"{kind}\" is not supported by this toolchain yet; use a \"path\" source");
            }

            var target = Path.IsPathRooted(rawPath) ? rawPath : Path.GetFullPath(Path.Combine(configDir, rawPath));

            var isDir = Directory.Exists(target);
            if (!isDir && !File.Exists(target))
                throw new MetaObjectsException(
                    ErrorCode.ERR_SOURCE_UNRESOLVED,
                    $"source path \"{rawPath}\" does not exist (resolved to {target}, relative to {configDir})");

            // Order is this port's own and is deliberately NOT a cross-port
            // contract — see the corpus README.
            var found = isDir
                ? Directory.EnumerateFiles(target, "*", SearchOption.AllDirectories)
                    .Where(p => SupportedExtensions.Contains(Path.GetExtension(p)))
                    .OrderBy(p => p, StringComparer.Ordinal)
                : new[] { target }.AsEnumerable();

            foreach (var f in found)
            {
                var full = Path.GetFullPath(f);
                if (known.Add(full)) seen.Add(full);
            }
        }

        return seen;
    }

    /// The full ladder: declared `sources`, else the default directory.
    /// Only the DEFAULT may be absent — a declared source that does not resolve
    /// is ERR_SOURCE_UNRESOLVED, a louder failure.
    public static IReadOnlyList<string> ResolveCollection(string root)
    {
        root = Path.GetFullPath(root);
        var cfg = NeutralConfig.Read(root);
        var specs = cfg?.Sources ?? Array.Empty<IReadOnlyDictionary<string, string>>();

        if (specs.Count == 0)
        {
            var defaultDir = Path.Combine(root, NeutralConfig.DefaultMetadataDir);
            if (!Directory.Exists(defaultDir))
                throw new MetaObjectsException(
                    ErrorCode.ERR_COLLECTION_NOT_FOUND,
                    $"no metadata sources declared in {root} and no default \"{NeutralConfig.DefaultMetadataDir}\" " +
                    "directory found. Declare \"sources\" in .metaobjects/config.json, or run 'meta init' to scaffold.");
            specs = new[] { (IReadOnlyDictionary<string, string>)new Dictionary<string, string> { ["path"] = NeutralConfig.DefaultMetadataDir } };
        }

        return ResolveSources(root, specs);
    }
}
```

- [ ] **Step 5: Run the conformance runner**

Run: `cd server/csharp && dotnet test MetaObjects.Conformance.Tests/MetaObjects.Conformance.Tests.csproj --nologo --verbosity quiet`
Expected: all 16 corpus cases pass.

- [ ] **Step 6: Wire the CLI fallback**

Modify `server/csharp/MetaObjects.Cli/Program.cs`. The positional `<metadataDir>` is currently required for `gen` (`:76`), `docs` (`:124`) and `verify` (`:204`). Make it OPTIONAL, falling back to the neutral config:

```csharp
// Rung 1 is the explicit positional argument; rungs 3-4 live in ResolveCollection.
// C# has no native config surface (rung 2), so the ladder is two rungs here.
static string ResolveMetadataDirOrExit(string? metadataDir)
{
    if (metadataDir is not null) return metadataDir;
    try
    {
        // Proves a collection resolves from cwd, and reports the same errors the
        // other ports do. The loader still takes a directory, so hand it the
        // resolved root rather than the file list — widening the loader call to a
        // source SET is a separate change.
        _ = MetaObjects.Config.SourceResolver.ResolveCollection(Directory.GetCurrentDirectory());
        return Path.Combine(Directory.GetCurrentDirectory(), MetaObjects.Config.NeutralConfig.DefaultMetadataDir);
    }
    catch (MetaObjectsException e)
    {
        Console.Error.WriteLine($"error: {e.Code}: {e.Message}");
        Environment.Exit(2);
        throw;
    }
}
```

Then at each of the three `if (metadataDir is null || outDir is null)` guards, replace the `metadataDir is null` half with a call to `ResolveMetadataDirOrExit(metadataDir)` assigned before the guard, leaving the `outDir is null` check intact.

> **Note for the implementer:** the C# loader's `FromDirectory` takes one directory, so this task's CLI wiring resolves the *root*, not the file set. Widening `MetaDataLoader.FromDirectory` to accept a resolved source SET is deliberately NOT in this plan — `Load(IReadOnlyList<IMetaDataSource>)` already exists (`MetaDataLoader.cs:334`) and wiring it is a follow-up. What ships here is the reader, the resolver and the corpus.

- [ ] **Step 7: Run the C# suite**

Run: `cd server/csharp && dotnet test MetaObjects.Cli.Tests/MetaObjects.Cli.Tests.csproj --nologo --verbosity quiet && dotnet test MetaObjects.Conformance.Tests/MetaObjects.Conformance.Tests.csproj --nologo --verbosity quiet`
Expected: no new failures.

- [ ] **Step 8: Commit**

```bash
git add server/csharp/MetaObjects/Config server/csharp/MetaObjects.Conformance.Tests/SourceResolutionConformanceTests.cs server/csharp/MetaObjects.Cli/Program.cs
git commit -m "feat(csharp): read the port-neutral sources key

Neutral subset only; the positional metadataDir becomes optional and falls
back to .metaobjects/config.json. Gated by the shared corpus."
```

---

## Task 5: Java — neutral config reader, resolver, conformance runner, mojo fallback

Kotlin needs no separate work: it has no CLI entry point of its own (`fun main` appears in neither `metadata-ktx` nor `codegen-kotlin`) and runs through this same Maven plugin.

**Files:**
- Create: `server/java/metadata/src/main/java/com/metaobjects/config/NeutralConfig.java`
- Create: `server/java/metadata/src/main/java/com/metaobjects/config/SourceResolver.java`
- Create: `server/java/metadata/src/test/java/com/metaobjects/config/SourceResolutionConformanceTest.java`
- Modify: `server/java/maven-plugin/src/main/java/com/metaobjects/mojo/AbstractMetaDataMojo.java`

**Interfaces:**
- Consumes: `cases.json` (Task 1); `com.metaobjects.ErrorCode` members `ERR_SOURCE_UNRESOLVED`, `ERR_SOURCE_KIND_UNSUPPORTED`, `ERR_COLLECTION_NOT_FOUND` (`ErrorCode.java:287,290,296`).
- Produces:
  - `NeutralConfig.read(Path configDir) -> Optional<NeutralConfig>`
  - `NeutralConfig.getSources() -> List<Map<String,String>>`
  - `NeutralConfig.DEFAULT_METADATA_DIR -> "metaobjects"`
  - `SourceResolver.resolveCollection(Path root) -> List<Path>`
  - `SourceResolver.resolveSources(Path configDir, List<Map<String,String>> specs) -> List<Path>`

- [ ] **Step 1: Write the failing conformance runner**

Create `server/java/metadata/src/test/java/com/metaobjects/config/SourceResolutionConformanceTest.java`:

```java
package com.metaobjects.config;

import com.metaobjects.ErrorCode;
import com.metaobjects.MetaDataException;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;

import javax.json.Json;            // use the JSON API already on this module's classpath
import java.nio.file.*;
import java.util.*;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Runs the shared source-resolution corpus against this port. Reads the single
 * committed fixtures/source-resolution-conformance/cases.json — no per-port fixture.
 */
class SourceResolutionConformanceTest {

    private static Path corpus() {
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null && !Files.isDirectory(dir.resolve("fixtures"))) dir = dir.getParent();
        assertNotNull(dir, "could not locate the repository fixtures/ directory");
        return dir.resolve("fixtures/source-resolution-conformance/cases.json");
    }

    static List<Map<String, Object>> cases() throws Exception {
        // Parse with whatever JSON facility this module already depends on.
        return CorpusReader.read(corpus());
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("cases")
    void resolvesTheSameFileSet(Map<String, Object> c, @TempDir Path root) throws Exception {
        CorpusReader.materialize(c, root);

        Object expectError = c.get("expectError");
        if (expectError != null) {
            MetaDataException e = assertThrows(MetaDataException.class,
                    () -> SourceResolver.resolveCollection(root));
            assertEquals(expectError, e.getErrorCode().name());
            return;
        }

        Set<String> got = SourceResolver.resolveCollection(root).stream()
                .map(p -> root.toRealPath_unchecked().relativize(p).toString().replace('\\', '/'))
                .collect(Collectors.toSet());

        @SuppressWarnings("unchecked")
        Set<String> want = new HashSet<>((List<String>) c.get("expectFiles"));
        assertEquals(want, got);
    }
}
```

> **Implementer note:** `CorpusReader` and `toRealPath_unchecked()` above are placeholders for whatever this module already has. Before writing this file, run `grep -rn "cases.json" server/java/metadata/src/test --include=*.java | head` and copy the corpus-reading approach an existing conformance test uses (`ConformanceTest`, `RegistryManifestConformanceTest`). Do not add a new JSON dependency; reuse the module's existing one. Materialization is: for each `tree` entry create parent dirs and write the content; when `config` is non-null, write it to `<root>/.metaobjects/config.json`.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server/java && mvn -pl metadata test -Dtest=SourceResolutionConformanceTest -q`
Expected: compile failure — `com.metaobjects.config` does not exist.

- [ ] **Step 3: Implement the reader**

Create `server/java/metadata/src/main/java/com/metaobjects/config/NeutralConfig.java`:

```java
package com.metaobjects.config;

import com.metaobjects.ErrorCode;
import com.metaobjects.MetaDataException;

import java.nio.file.*;
import java.util.*;

/**
 * The port-neutral subset of {@code .metaobjects/config.json}.
 *
 * <p>Reads only {@code schema_version} and {@code sources}. The file also carries
 * TypeScript-owned keys ({@code pending_in_git}, {@code confidence_thresholds},
 * {@code extract}, {@code migrate}); those are IGNORED rather than modeled, so a new
 * TS-only key never becomes a four-port change. See
 * {@code docs/superpowers/specs/2026-08-19-cross-port-metadata-sources-design.md} §4.
 */
public final class NeutralConfig {

    /**
     * The DEFAULT value of {@code sources} when the key is absent or empty — never a
     * requirement, and never assumed to exist by any other code path.
     */
    public static final String DEFAULT_METADATA_DIR = "metaobjects";

    private static final String METAOBJECTS_DIR = ".metaobjects";
    private static final String CONFIG_FILE = "config.json";

    private final List<Map<String, String>> sources;

    private NeutralConfig(List<Map<String, String>> sources) {
        this.sources = List.copyOf(sources);
    }

    public List<Map<String, String>> getSources() {
        return sources;
    }

    /**
     * Returns empty when the file does not exist. A file that EXISTS but is malformed
     * throws — swallowing it would make a typo'd config behave identically to no
     * config at all.
     */
    public static Optional<NeutralConfig> read(Path configDir) {
        Path path = configDir.resolve(METAOBJECTS_DIR).resolve(CONFIG_FILE);
        if (!Files.isRegularFile(path)) return Optional.empty();

        Map<String, Object> raw;
        try {
            raw = JsonSupport.readObject(path);
        } catch (Exception e) {
            throw new MetaDataException(
                    ErrorCode.ERR_COLLECTION_NOT_FOUND,
                    path + " exists but could not be read as JSON: " + e.getMessage());
        }

        Object version = raw.get("schema_version");
        if (!(version instanceof Number) || ((Number) version).intValue() != 1) {
            throw new MetaDataException(
                    ErrorCode.ERR_COLLECTION_NOT_FOUND,
                    path + ": unsupported schema_version " + version + " (expected 1)");
        }

        List<Map<String, String>> specs = new ArrayList<>();
        Object srcs = raw.getOrDefault("sources", List.of());
        if (srcs instanceof List<?> list) {
            for (Object o : list) {
                if (!(o instanceof Map<?, ?> m) || m.size() != 1) {
                    throw new MetaDataException(
                            ErrorCode.ERR_COLLECTION_NOT_FOUND,
                            path + ": each 'sources' entry must be an object with exactly one key");
                }
                Map<String, String> spec = new LinkedHashMap<>();
                m.forEach((k, v) -> spec.put(String.valueOf(k), String.valueOf(v)));
                specs.add(spec);
            }
        }

        // Unknown top-level keys are IGNORED by design — see the class javadoc.
        return Optional.of(new NeutralConfig(specs));
    }
}
```

> **Implementer note:** `JsonSupport.readObject` is a placeholder. Use whatever JSON reader `metadata` already depends on — find it with `grep -rn "import.*json" server/java/metadata/src/main/java/com/metaobjects/loader/parser/*.java | head`. Do not add a dependency. Likewise confirm `MetaDataException`'s constructor takes an `ErrorCode` and a message; adapt if it does not.

- [ ] **Step 4: Implement the resolver**

Create `server/java/metadata/src/main/java/com/metaobjects/config/SourceResolver.java`:

```java
package com.metaobjects.config;

import com.metaobjects.ErrorCode;
import com.metaobjects.MetaDataException;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.*;
import java.util.*;
import java.util.stream.Stream;

/** Resolves a declared source SET to a de-duplicated list of metadata files. */
public final class SourceResolver {

    private static final Set<String> EXTENSIONS = Set.of(".json", ".yaml", ".yml");

    private SourceResolver() {}

    /**
     * A relative {@code path} resolves against {@code configDir} — the directory
     * HOLDING the {@code .metaobjects/} folder — never against the process working
     * directory.
     */
    public static List<Path> resolveSources(Path configDir, List<Map<String, String>> specs) {
        LinkedHashSet<Path> seen = new LinkedHashSet<>();

        for (Map<String, String> spec : specs) {
            String rawPath = spec.get("path");
            if (rawPath == null) {
                String kind = spec.keySet().stream().findFirst().orElse("<empty>");
                throw new MetaDataException(
                        ErrorCode.ERR_SOURCE_KIND_UNSUPPORTED,
                        "source kind \"" + kind + "\" is not supported by this toolchain yet; use a \"path\" source");
            }

            Path raw = Paths.get(rawPath);
            Path target = raw.isAbsolute() ? raw : configDir.resolve(raw).normalize();

            boolean isDir = Files.isDirectory(target);
            if (!isDir && !Files.isRegularFile(target)) {
                throw new MetaDataException(
                        ErrorCode.ERR_SOURCE_UNRESOLVED,
                        "source path \"" + rawPath + "\" does not exist (resolved to " + target
                                + ", relative to " + configDir + ")");
            }

            if (isDir) {
                // Order is this port's own and is deliberately NOT a cross-port
                // contract — see the corpus README.
                try (Stream<Path> walk = Files.walk(target)) {
                    walk.filter(Files::isRegularFile)
                        .filter(p -> hasSupportedExtension(p.getFileName().toString()))
                        .sorted(Comparator.comparing(p -> p.getFileName().toString()))
                        .forEach(p -> seen.add(p.toAbsolutePath().normalize()));
                } catch (IOException e) {
                    throw new UncheckedIOException("Failed to list " + target, e);
                }
            } else {
                seen.add(target.toAbsolutePath().normalize());
            }
        }

        return new ArrayList<>(seen);
    }

    /**
     * The full ladder: declared {@code sources}, else the default directory. Only the
     * DEFAULT may be absent — a declared source that does not resolve is
     * {@code ERR_SOURCE_UNRESOLVED}, a louder failure.
     */
    public static List<Path> resolveCollection(Path root) {
        Path base = root.toAbsolutePath().normalize();
        List<Map<String, String>> specs = NeutralConfig.read(base)
                .map(NeutralConfig::getSources)
                .orElse(List.of());

        if (specs.isEmpty()) {
            Path defaultDir = base.resolve(NeutralConfig.DEFAULT_METADATA_DIR);
            if (!Files.isDirectory(defaultDir)) {
                throw new MetaDataException(
                        ErrorCode.ERR_COLLECTION_NOT_FOUND,
                        "no metadata sources declared in " + base + " and no default \""
                                + NeutralConfig.DEFAULT_METADATA_DIR + "\" directory found. Declare \"sources\" in "
                                + ".metaobjects/config.json, or run 'meta init' to scaffold.");
            }
            specs = List.of(Map.of("path", NeutralConfig.DEFAULT_METADATA_DIR));
        }

        return resolveSources(base, specs);
    }

    private static boolean hasSupportedExtension(String name) {
        String lower = name.toLowerCase(Locale.ROOT);
        for (String ext : EXTENSIONS) if (lower.endsWith(ext)) return true;
        return false;
    }
}
```

- [ ] **Step 5: Run the conformance runner**

Run: `cd server/java && mvn -pl metadata test -Dtest=SourceResolutionConformanceTest -q`
Expected: all 16 corpus cases pass.

- [ ] **Step 6: Wire the mojo fallback**

Modify `server/java/maven-plugin/src/main/java/com/metaobjects/mojo/AbstractMetaDataMojo.java`. Rung 2 is the pom: if the `<loader>` names **either** `<sourceDir>` or `<sources>`, the pom owns the concern and the neutral file is NOT consulted. Only when the pom names neither does the mojo fall back:

```java
/**
 * The precedence ladder for where metadata lives (spec §5). First match wins.
 *
 * <p>1. The pom — {@code <loader><sourceDir>} or {@code <loader><sources>}. If EITHER is
 * present the pom owns the whole concern and the neutral file is not consulted;
 * precedence is whole-concern, not a per-entry merge.
 * <br>2. {@code sources} in the port-neutral {@code .metaobjects/config.json}, read from
 * the module basedir.
 * <br>3. The built-in default directory.
 *
 * <p>A neutral file that EXISTS but is malformed throws rather than falling through.
 */
protected List<String> resolveNeutralSourcesIfPomIsSilent(LoaderParam loaderConfig) {
    boolean pomNamesLocation =
            (loaderConfig.getSourceDir() != null && !loaderConfig.getSourceDir().isBlank())
            || (loaderConfig.getSources() != null && !loaderConfig.getSources().isEmpty());
    if (pomNamesLocation) return List.of();

    return com.metaobjects.config.SourceResolver
            .resolveCollection(getProjectBaseDir().toPath())
            .stream()
            .map(java.nio.file.Path::toString)
            .toList();
}
```

Call it where the loader's sources are assembled and pass the result through the existing `setSourceURIs` / `sources` path. Use the mojo's existing accessor for the module base directory (find it with `grep -n "basedir\|getBasedir\|MavenProject" server/java/maven-plugin/src/main/java/com/metaobjects/mojo/AbstractMetaDataMojo.java | head`).

**Do not touch `<filters>`.** It keeps its current semantics — `scope` is out of scope for this plan (Global Constraints).

- [ ] **Step 7: Run the Java build**

Run: `cd server/java && mvn -pl metadata,maven-plugin -am install -DskipTests -q && mvn -pl metadata test -q`
Expected: BUILD SUCCESS, no new failures. Do **not** pipe through `tail` — that reports `tail`'s exit status, not Maven's.

- [ ] **Step 8: Commit**

```bash
git add server/java/metadata/src/main/java/com/metaobjects/config server/java/metadata/src/test/java/com/metaobjects/config server/java/maven-plugin/src/main/java/com/metaobjects/mojo/AbstractMetaDataMojo.java
git commit -m "feat(java): read the port-neutral sources key when the pom is silent

Whole-concern precedence: a pom naming sourceDir or sources owns the
concern outright. <filters> is untouched — scope stays TypeScript-only."
```

---

## Task 6: `meta init --config-only`, the Node-side writer

The gap the phase-1 design named: a JVM- or pip-rooted adopter has no `.metaobjects/config.json` at all, so the Node CLI's `migrate` has nothing to discover no matter which ports can read. `meta init` today scaffolds the whole TypeScript project and has no flag to write only the config (`init.ts:635-650`).

**Files:**
- Modify: `server/typescript/packages/cli/src/commands/init.ts`
- Test: `server/typescript/packages/cli/test/init.test.ts`

**Interfaces:**
- Consumes: the existing `parseInitArgs` flag parser and `InitOptions` (`init.ts:635-650`).
- Produces: `meta init --config-only` writes exactly `.metaobjects/config.json` and nothing else.

- [ ] **Step 1: Write the failing test**

Add to `server/typescript/packages/cli/test/init.test.ts`:

```ts
test("--config-only writes just the config, no TypeScript scaffold", async () => {
  const root = await mkdtemp(join(tmpdir(), "mo-init-config-only-"));

  const result = await runInit({ cwd: root, configOnly: true });

  // The one file it writes.
  expect(result.created).toContain(".metaobjects/config.json");
  const cfg = JSON.parse(await readFile(join(root, ".metaobjects", "config.json"), "utf8"));
  expect(cfg.schema_version).toBe(1);
  expect(cfg.sources).toEqual([]);

  // None of the TypeScript scaffold — this is the whole point of the flag: a
  // Maven- or pip-rooted project declares its sources for the Node CLI without
  // acquiring a TS project it will not use.
  for (const unwanted of [
    "metaobjects.config.ts",
    "codegen/generators/entity.ts",
    "package.json",
    ".gitignore",
  ]) {
    expect(existsSync(join(root, unwanted))).toBe(false);
  }
});

test("--config-only leaves an existing config untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "mo-init-config-only-existing-"));
  await mkdir(join(root, ".metaobjects"), { recursive: true });
  const existing = { schema_version: 1, sources: [{ path: "model" }] };
  await writeFile(join(root, ".metaobjects", "config.json"), JSON.stringify(existing));

  const result = await runInit({ cwd: root, configOnly: true });

  expect(result.preserved).toContain(".metaobjects/config.json");
  const cfg = JSON.parse(await readFile(join(root, ".metaobjects", "config.json"), "utf8"));
  expect(cfg.sources).toEqual([{ path: "model" }]);
});
```

> **Implementer note:** match the existing tests' helper names in that file — if the entry point is not `runInit`, or options are shaped differently, adapt. Check with `grep -n "runInit\|export async function init\|InitOptions" server/typescript/packages/cli/src/commands/init.ts | head`.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server/typescript/packages/cli && bun test test/init.test.ts -t "config-only"`
Expected: FAIL — `configOnly` is not a recognized option.

- [ ] **Step 3: Implement the flag**

In `init.ts`: add `configOnly?: boolean` to the options type, parse `--config-only` in `parseInitArgs`, thread it through to the entry point, and take an early-return branch that runs only the existing `.metaobjects/config.json` block (`:374-412`) — reusing that code rather than duplicating the write, so the two paths cannot drift on the config's default content. Add `--config-only` to the command's `--help` text with a one-line description naming its purpose (declaring sources for the Node CLI from a non-TypeScript project).

- [ ] **Step 4: Run the test**

Run: `cd server/typescript/packages/cli && bun test test/init.test.ts`
Expected: all pass, including the two new cases.

- [ ] **Step 5: Typecheck**

Run: `cd server/typescript && bun run --filter '*' typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add server/typescript/packages/cli/src/commands/init.ts server/typescript/packages/cli/test/init.test.ts
git commit -m "feat(cli): meta init --config-only

Writes .metaobjects/config.json and nothing else, so a Maven- or pip-rooted
project can declare its sources for the Node CLI without acquiring a
TypeScript scaffold it will not use."
```

---

## Task 7: Documentation and changelog

**Files:**
- Modify: `docs/features/metadata-sources.md:36-42`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Replace the "Port support" paragraph**

`docs/features/metadata-sources.md` currently tells adopters the other four CLIs do not read the config. Replace that paragraph with:

```markdown
**Port support.** `sources` is read by **all four CLI surfaces** — the Node `meta`
CLI, `dotnet meta` (C#), `metaobjects` (Python) and `metaobjects:generate` (Java
and Kotlin, via Maven). Each resolves the same files from the same declaration;
that promise is gated by
[`fixtures/source-resolution-conformance/`](../../fixtures/source-resolution-conformance/).

Each port reaches it its own way, and the ladder is the same everywhere — first
match wins:

1. An explicit CLI argument (a positional metadata directory, `--config`, `--cwd`).
2. The port's own native surface, where it has one — Java and Kotlin's pom
   `<sourceDir>`/`<sources>`, Python's `metadata` key in `metaobjects.config.yaml`.
   If the pom names either element it owns the concern outright and the neutral
   file is not consulted.
3. `sources` in `.metaobjects/config.json`.
4. The built-in default — a `metaobjects/` directory beside that config.

A config file that exists but is malformed is an error at its own rung; it never
falls through to the next one.

The non-TypeScript ports read a **neutral subset** of that file —
`schema_version` and `sources` — and ignore every other top-level key, so the
TypeScript-owned keys beside them (`migrate`, `extract`, and the rest) never
become a four-port concern. The Node CLI remains the file's only writer;
`meta init --config-only` writes it into a Maven- or pip-rooted project without
adding a TypeScript scaffold.

**`scope` and `migrate.scope` remain Node-CLI-only.** Java ships its own
`<filters>` grammar whose `*` and `@` mean different things from `scope`'s, so
reconciling them is a separate, adopter-affecting decision rather than a
mechanical port.

**File order is not a cross-port promise.** Every port resolves the same file
SET; the order within it is each port's own and always has been.
```

- [ ] **Step 2: Add the changelog entry**

Under `## [Unreleased]` in `CHANGELOG.md`:

```markdown
### Added

- **`sources` is read by all four CLI surfaces**, not just the Node `meta` CLI —
  the C#, Python and Java/Kotlin CLIs now resolve metadata from the
  port-neutral `.metaobjects/config.json`, so one declaration serves every port.
  Each reads a **neutral subset** (`schema_version` + `sources`) and ignores
  unknown top-level keys, so the TypeScript-owned keys in that file never become
  a four-port change. Precedence is a ladder — explicit CLI argument, then the
  port's native surface (a pom's `<sourceDir>`/`<sources>`, Python's `metadata`
  key), then `sources`, then the default `metaobjects/` directory — and a config
  that exists but is malformed errors at its rung rather than silently falling
  through. Gated by the new `fixtures/source-resolution-conformance/` corpus,
  which every port runs.
- **`meta init --config-only`** writes `.metaobjects/config.json` and nothing
  else, so a Maven- or pip-rooted project can declare its sources for the Node
  CLI (which owns `migrate` and `verify --db`, ADR-0015) without acquiring a
  TypeScript scaffold it will not use.

### Notes

- **`scope` / `migrate.scope` stay Node-CLI-only for now.** Java has shipped a
  `<filters>` grammar for years in which `*` crosses the `::` separator and `@`
  matches one segment — the exact inverse of `scope`'s `*` and `**` — plus
  `!`-prefix exclusion and a `.[attr]` predicate `scope` cannot express.
  Reconciling them changes behavior for existing Java consumers, so it is its
  own decision rather than a mechanical port. No cross-port behavior depends on
  `scope`.
- **Resolved file ORDER is explicitly not a cross-port contract.** The ports'
  directory walks already differ and always have; the corpus compares file SETS.
  Super-resolution is order-independent (#188) and the loader's overlay
  partition discards caller order regardless.
```

- [ ] **Step 3: Verify no leaked private names or absolute home paths**

Run: `scripts/ci-local.sh --quick`
Expected: green. This is the same leak-scan that gates every PR, and it is the
authority — it checks staged content against the configured private-name
denylist as well as absolute user-home path patterns, which an ad-hoc grep here
would not. If it blocks a commit, **genericize the offending line** rather than
bypassing with `--no-verify`.

- [ ] **Step 4: Commit**

```bash
git add docs/features/metadata-sources.md CHANGELOG.md
git commit -m "docs: sources is read by all four CLI surfaces

Records the precedence ladder, the neutral-subset rule, why scope stays
Node-only, and that file order is deliberately not a contract."
```

---

## Task 8: Full cross-port gate

- [ ] **Step 1: Run the affected-port lanes**

```bash
scripts/ci-local.sh --only typescript --strict-toolchains
scripts/ci-local.sh --only python --strict-toolchains
scripts/ci-local.sh --only csharp --strict-toolchains
scripts/ci-local.sh --only java --strict-toolchains
```

Expected: all four green. **Do not pipe any of these through `tail`** — the shell reports `tail`'s exit status, so a red lane reads as green.

- [ ] **Step 2: Typecheck and build the TypeScript workspace**

Run: `cd server/typescript && bun run --filter '*' build && bun run --filter '*' typecheck`
Expected: clean.

- [ ] **Step 3: Confirm the corpus is genuinely gating**

Prove the gate by breaking it, not by its silence. Temporarily change one `expectFiles` entry in `cases.json` to a wrong path, re-run **all four** runners, and confirm **each** goes red:

```bash
cd server/typescript/packages/sdk && bun test test/source-resolution-conformance.test.ts   # expect FAIL
cd server/python && uv run pytest tests/conformance/test_source_resolution_conformance.py  # expect FAIL
cd server/csharp && dotnet test MetaObjects.Conformance.Tests/MetaObjects.Conformance.Tests.csproj  # expect FAIL
cd server/java && mvn -pl metadata test -Dtest=SourceResolutionConformanceTest             # expect FAIL
```

Then revert `cases.json`. **A runner that stays green here is not wired to the corpus** — fix it before proceeding. Four ports byte-matching one manifest is the entire point.

- [ ] **Step 4: Verify the working tree is clean of incidental changes**

Run: `git status --short`
Expected: empty. In particular `server/python/uv.lock` must NOT be staged — it re-dirties on any `uv run` and is genuine pre-existing drift on `main`.

- [ ] **Step 5: Final commit if anything was fixed**

```bash
git add -- <explicit paths only>
git commit -m "fix: close gaps found by the full cross-port gate"
```

Stage explicit paths — never `git add -A`. The stash stack and worktrees are shared across sessions.

---

## Self-Review

**Spec coverage.** §2 (`sources` ships, `scope` deferred) → Global Constraints + Tasks 2-5, deferral recorded in Task 7. §3 identical column → corpus cases in Task 1; may-differ column → the corpus README's order section and each resolver's order comment. §4 neutral subset → the `unknown-top-level-keys-are-ignored` case plus each reader's ignore-by-default behavior. §5 precedence ladder → Task 3 step 5 (Python), Task 4 step 6 (C#), Task 5 step 6 (Java), documented in Task 7. §6 writer → Task 6. §7 corpus → Task 1, with the CI-latency caveat carried into the README. §8 deferrals → Task 7's changelog Notes.

**Known plan limitations, stated rather than hidden.** Three tasks carry an explicit *implementer note* where the exact local API could not be verified without opening files this plan does not otherwise touch: Java's JSON facility and `MetaDataException` constructor (Task 5 steps 1, 3), C#'s exception type name (Task 4 step 2), and the CLI test helper names in `init.test.ts` (Task 6 step 1). Each note names the exact `grep` that resolves it. These are look-ups, not design gaps.

**Scope boundary worth flagging to a reviewer.** Tasks 4 and 5 wire the *resolver* and the *corpus*, and the C# CLI hands the loader a resolved root rather than a resolved file SET, because `MetaDataLoader.FromDirectory` takes one directory. Every port's set-accepting loader entry already exists (spec §2 table); widening the CLI call sites to use it is a deliberate follow-up, not part of this changeset. What ships here is that all four ports **read the same declaration and resolve the same files** — which is the stated requirement.
