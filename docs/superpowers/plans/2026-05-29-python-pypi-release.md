# Python → PyPI Release (v0.7.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the Python port (`metaobjects`) to PyPI at version `0.7.0` as a clean, professional package, with a reusable release procedure documented.

**Architecture:** This is a packaging + publishing task, not a feature build. The unit of verification is not a unit test but a build/validate/install gate: `uv build` → `twine check` → TestPyPI dry-run + clean-venv install → real PyPI publish. The package source and 642 tests are already green; we are only adding distribution metadata, a PyPI-facing README, a bundled LICENSE, and the publish procedure. Per the GTM version decision (`docs/superpowers/specs/2026-05-28-go-to-market-launch-readiness-plan-design.md`), the newer ports (TS, C#, Python) share `0.7.x`; JVM ports stay `7.x`.

**Tech Stack:** Python ≥3.11, hatchling build backend, `uv` (build + publish), `twine` (validation), PyPI + TestPyPI.

---

## Prerequisites (one-time, the user does these — interactive)

These are credential/account steps the assistant cannot do; the user runs them (use the `! <cmd>` prompt prefix for interactive logins, or paste tokens when asked):

1. **PyPI account** at <https://pypi.org> with 2FA enabled.
2. **TestPyPI account** at <https://test.pypi.org> (separate registry, separate account) for the dry run.
3. **API tokens** — create a scoped token on each (Account settings → API tokens). For the first publish the project does not exist yet, so create an **account-scoped** token (can be narrowed to a project-scoped token after the first upload). Have both tokens ready:
   - TestPyPI token (used in Task 5)
   - PyPI token (used in Task 6)
4. **Confirm the `metaobjects` name is still free on PyPI** — verified 404 on 2026-05-28; re-check at publish time: `curl -sI https://pypi.org/pypi/metaobjects/json | head -1` should be `HTTP/2 404`.

> Modern best practice is **Trusted Publishing (OIDC)** via GitHub Actions instead of a long-lived token. We use a token for this first *manual* publish (mirrors the Java manual `mvn deploy` flow); Task 8 documents setting up trusted publishing for future automated releases.

---

## File Structure

- `server/python/pyproject.toml` — **modify**: add all PyPI distribution metadata (version, license, urls, authors, classifiers, keywords, readme).
- `server/python/LICENSE` — **create**: copy of the repo-root Apache-2.0 LICENSE so it ships in the sdist/wheel.
- `server/python/README.md` — **rewrite**: becomes the PyPI project page (absolute links, accurate scope, install + usage).
- `docs/RELEASING-python.md` — **create**: the repeatable release procedure (mirrors `docs/RELEASING-java.md`).

---

### Task 1: Bundle the LICENSE into the package

**Files:**
- Create: `server/python/LICENSE` (copy of `/LICENSE`)

- [ ] **Step 1: Copy the repo-root LICENSE into the Python project**

Run:
```bash
cd /home/doug/Development/metaobjects
cp LICENSE server/python/LICENSE
```

- [ ] **Step 2: Verify it copied identically**

Run: `diff LICENSE server/python/LICENSE && echo IDENTICAL`
Expected: `IDENTICAL` (no diff output).

- [ ] **Step 3: Commit**

```bash
git add server/python/LICENSE
git commit -m "chore(python): bundle Apache-2.0 LICENSE into the package for PyPI"
```

---

### Task 2: Fill PyPI distribution metadata in pyproject.toml

**Files:**
- Modify: `server/python/pyproject.toml` (the `[project]` table + add `[project.urls]`)

- [ ] **Step 1: Replace the `[project]` table and add `[project.urls]`**

Replace the current `[project]` block (lines 1–10) with exactly:

```toml
[project]
name = "metaobjects"
version = "0.7.0"
description = "Cross-language metadata standard: declare typed entities once, generate idiomatic drift-checked code across languages — Python port."
readme = "README.md"
requires-python = ">=3.11"
license = "Apache-2.0"
license-files = ["LICENSE"]
authors = [{ name = "Doug Mealing", email = "doug@metaobjects.com" }]
keywords = [
    "metadata",
    "code-generation",
    "codegen",
    "schema",
    "orm",
    "drift-detection",
    "cross-language",
    "sqlalchemy",
    "pydantic",
    "fastapi",
]
classifiers = [
    "Development Status :: 4 - Beta",
    "Intended Audience :: Developers",
    "Operating System :: OS Independent",
    "Programming Language :: Python :: 3",
    "Programming Language :: Python :: 3.11",
    "Programming Language :: Python :: 3.12",
    "Programming Language :: Python :: 3.13",
    "Topic :: Software Development :: Code Generators",
    "Topic :: Software Development :: Libraries",
    "Typing :: Typed",
]
dependencies = [
    # YAML authoring front-end (ADR-0006). The desugar lowers sugared YAML to
    # canonical JSON before the shared tree-builder runs.
    "PyYAML>=6.0",
]

[project.urls]
Homepage = "https://metaobjects.dev"
Repository = "https://github.com/metaobjectsdev/metaobjects"
Documentation = "https://github.com/metaobjectsdev/metaobjects/tree/main/docs"
Issues = "https://github.com/metaobjectsdev/metaobjects/issues"
```

> **Note on license:** we use the PEP 639 SPDX expression (`license = "Apache-2.0"` + `license-files`). Do NOT also add a `License :: OSI Approved ::` classifier — modern build backends reject having both the SPDX expression and a license classifier.

- [ ] **Step 2: Exclude the internal KNOWN_GAPS.md from the wheel**

In the existing `[tool.hatch.build.targets.wheel]` table, change it to:

```toml
[tool.hatch.build.targets.wheel]
packages = ["src/metaobjects"]
exclude = ["**/KNOWN_GAPS.md"]
```

- [ ] **Step 3: Verify the file still parses and the version is set**

Run: `cd server/python && uv version 2>/dev/null || python3 -c "import tomllib,sys; d=tomllib.load(open('pyproject.toml','rb')); print(d['project']['name'], d['project']['version'], d['project']['license'])"`
Expected: `metaobjects 0.7.0 Apache-2.0`

- [ ] **Step 4: Commit**

```bash
git add server/python/pyproject.toml
git commit -m "feat(python): add PyPI distribution metadata + set version 0.7.0"
```

---

### Task 3: Rewrite README.md as the PyPI project page

**Files:**
- Modify: `server/python/README.md` (full rewrite)

The current README is dev-facing, uses repo-relative links that break on the PyPI page, and understates scope ("loader + conformance; codegen and runtime out of scope") — but the wheel actually ships `codegen`, `render`, `runtime`, `migrate`, `documentation`, `source`, `meta`, `shared`, `loader`. The rewrite must use absolute links and state accurate scope.

- [ ] **Step 1: Replace the entire README.md with the PyPI-facing version**

```markdown
# MetaObjects (Python)

The Python port of the [MetaObjects](https://metaobjects.dev) cross-language metadata
standard: declare your typed entity model once, then generate idiomatic, drift-checked
code across TypeScript, Java, C#, Python, and Kotlin. The metamodel is the durable spine;
generated code is the disposable artifact.

Behavior is verified byte-for-byte against the same shared conformance corpora as every
other language port.

## Install

```bash
pip install metaobjects
```

Requires Python 3.11+. The only runtime dependency is PyYAML.

## Quick start

Load a directory of metadata (`*.json` canonical or sigil-free `*.yaml`):

```python
from metaobjects import load_directory

result = load_directory("metaobjects/")   # your *.json / *.yaml metadata files

if result.errors:
    for err in result.errors:
        print(err)          # structured MetaError with a stable ErrorCode
else:
    root = result.root      # the merged metadata tree (a MetaData node)
    print(root)
```

`load_directory`, `load_uris`, and `load_string` are module-level shortcuts over
`MetaDataLoader`; all return a `LoadResult` with the same field shape as the other ports.

## What's in the package

The primary public API is the **loader** (`load_directory` / `load_uris` /
`load_string`, `MetaDataLoader`, `LoadResult`, `ErrorCode`, `MetaError`). The
distribution also ships the Python implementations of the other pillars used by the CLI
and tooling: `codegen` (Pydantic + FastAPI emit), `render` (Mustache + payload-VO +
verify), `runtime` (SQLAlchemy-Core object manager), and `migrate`.

## Authoring formats

- **Canonical JSON** (`*.json`) — the cross-language interchange shape.
- **Sigil-free YAML** (`*.yaml` / `*.yml`) — the AI-first authoring front-end
  ([ADR-0006](https://github.com/metaobjectsdev/metaobjects/blob/main/spec/decisions/ADR-0006-ai-first-yaml-authoring.md)).
  Desugared to canonical JSON at load time. A directory may mix both freely.

## Links

- Standard, docs, and the other four ports: <https://metaobjects.dev>
- Source & issues: <https://github.com/metaobjectsdev/metaobjects>
- Full docs: <https://github.com/metaobjectsdev/metaobjects/tree/main/docs>

## License

Apache-2.0. See [LICENSE](https://github.com/metaobjectsdev/metaobjects/blob/main/LICENSE).
```

- [ ] **Step 2: Verify no repo-relative links remain**

Run: `cd server/python && grep -nE "\]\(\.\./|\]\((?!https?://|#)" README.md || echo "NO RELATIVE LINKS"`
Expected: `NO RELATIVE LINKS`

- [ ] **Step 3: Commit**

```bash
git add server/python/README.md
git commit -m "docs(python): rewrite README as the PyPI project page (absolute links, accurate scope)"
```

---

### Task 4: Build + validate the distribution (the gate)

**Files:** none modified — this is a verification task.

- [ ] **Step 1: Clean any prior build output**

Run: `cd server/python && rm -rf dist`

- [ ] **Step 2: Build the sdist + wheel**

Run: `cd server/python && uv build`
Expected: `dist/metaobjects-0.7.0.tar.gz` and `dist/metaobjects-0.7.0-py3-none-any.whl` created, no errors.
If the PEP 639 `license` field errors (old hatchling), the failure will name it — fix by upgrading the build (uv resolves latest hatchling automatically; if pinned, bump it).

- [ ] **Step 3: Validate metadata + README rendering with twine**

Run: `cd server/python && uvx twine check dist/*`
Expected: `Checking dist/metaobjects-0.7.0-py3-none-any.whl: PASSED` and the same for the `.tar.gz`.

- [ ] **Step 4: Confirm the LICENSE + py.typed ship and tests do NOT**

Run:
```bash
cd server/python
python3 -c "import zipfile; z=zipfile.ZipFile('dist/metaobjects-0.7.0-py3-none-any.whl'); names=z.namelist(); \
print('LICENSE:', any('LICENSE' in n for n in names)); \
print('py.typed:', any(n.endswith('py.typed') for n in names)); \
print('no tests:', not any('/tests/' in n or n.startswith('tests/') for n in names)); \
print('no KNOWN_GAPS:', not any('KNOWN_GAPS' in n for n in names))"
```
Expected: all four print `True`.

- [ ] **Step 5: Confirm the full test suite is still green (no source changed, but verify)**

Run: `cd server/python && uv run --extra dev pytest -q`
Expected: all tests pass (642 collected as of 2026-05-29; integration tests needing Docker may be skipped/deselected — that's fine).

No commit (no files changed).

---

### Task 5: TestPyPI dry-run publish + clean-install smoke test

**Files:** none modified — verification against the real upload+install path.

- [ ] **Step 1: Upload to TestPyPI**

Run (paste the TestPyPI token when prompted, username `__token__`):
```bash
cd server/python && uv publish --publish-url https://test.pypi.org/legacy/ dist/*
```
Expected: upload succeeds; the package appears at <https://test.pypi.org/project/metaobjects/0.7.0/>.

- [ ] **Step 2: Open the TestPyPI page and eyeball it**

Visit <https://test.pypi.org/project/metaobjects/> and confirm: the README renders, the description/links/classifiers/license show, version is `0.7.0`.

- [ ] **Step 3: Install from TestPyPI into a throwaway venv and smoke-test the import**

Run:
```bash
cd /tmp && rm -rf mo-smoke && uv venv mo-smoke --python 3.11 && \
  uv pip install --python /tmp/mo-smoke/bin/python \
  --index-url https://test.pypi.org/simple/ \
  --extra-index-url https://pypi.org/simple/ \
  metaobjects==0.7.0 && \
  /tmp/mo-smoke/bin/python -c "import metaobjects; from metaobjects import load_directory, MetaDataLoader, LoadResult; print('import OK', metaobjects.__file__)"
```
Expected: install resolves (PyYAML pulled from the real PyPI via the extra index), and `import OK <path>` prints. This is the equivalent of the npm "real external install" smoke test.

- [ ] **Step 4: Clean up the smoke venv**

Run: `rm -rf /tmp/mo-smoke`

No commit.

> **STOP / GATE:** Task 6 is the irreversible real-PyPI publish. Do not proceed past this point without the user's explicit go-ahead (same discipline as the Java Maven Central deploy). PyPI versions are immutable — `0.7.0` can never be re-uploaded once published.

---

### Task 6: Publish to PyPI (irreversible — user-gated)

**Files:** none modified.

- [ ] **Step 1: Re-confirm the name is free and the build is the validated one**

Run: `curl -sI https://pypi.org/pypi/metaobjects/json | head -1`
Expected: `HTTP/2 404` (still unclaimed). And confirm `dist/` still holds only the `0.7.0` artifacts validated in Task 4 (`ls server/python/dist`).

- [ ] **Step 2: Publish to PyPI**

Run (paste the PyPI token when prompted, username `__token__`):
```bash
cd server/python && uv publish dist/*
```
Expected: upload succeeds; BUILD/UPLOAD reports success. **Once this returns, 0.7.0 is live and permanent.**

No commit.

---

### Task 7: Verify the live release

**Files:** none modified.

- [ ] **Step 1: Confirm PyPI now serves 0.7.0**

Run: `curl -s https://pypi.org/pypi/metaobjects/json | python3 -c "import sys,json; d=json.load(sys.stdin); print('latest:', d['info']['version'])"`
Expected: `latest: 0.7.0`

- [ ] **Step 2: Install from real PyPI in a clean venv and smoke-test**

Run:
```bash
cd /tmp && rm -rf mo-prod && uv venv mo-prod --python 3.11 && \
  uv pip install --python /tmp/mo-prod/bin/python metaobjects==0.7.0 && \
  /tmp/mo-prod/bin/python -c "import metaobjects; from metaobjects import load_directory; print('prod install OK', metaobjects.__file__)" && \
  rm -rf /tmp/mo-prod
```
Expected: `prod install OK <path>`.

- [ ] **Step 3: Eyeball the live page**

Visit <https://pypi.org/project/metaobjects/> — README renders, links resolve, license + classifiers present.

No commit (release is on PyPI, not in git; the git state is already at 0.7.0).

---

### Task 8: Document the release procedure

**Files:**
- Create: `docs/RELEASING-python.md`

- [ ] **Step 1: Write the release guide**

```markdown
# Releasing the Python port to PyPI

_Written from the 0.7.0 first publish (2026-05-29)._

## Companion docs

[`docs/RELEASING.md`](RELEASING.md) is TS/npm; [`docs/RELEASING-java.md`](RELEASING-java.md)
is Maven Central. Each ecosystem has its own guide. Python versions independently on the
`0.7.x` track shared with TS and C# (JVM ports use `7.x`) — see
`docs/superpowers/specs/2026-05-28-go-to-market-launch-readiness-plan-design.md`.

## What gets published

One distribution, `metaobjects`, built from `server/python/` (src-layout, package
`src/metaobjects`). Build backend: hatchling. Tool: `uv`.

## Prerequisites (one-time)

- PyPI + TestPyPI accounts (2FA). API tokens (`__token__` as username).
- `uv` installed. The build/test use a managed Python ≥3.11.
- Recommended for automation: **Trusted Publishing (OIDC)** — register a PyPI "pending
  publisher" for `metaobjects` bound to a GitHub Actions workflow in this repo, then a
  `release-python.yml` can `uv build` + publish via `pypa/gh-action-pypi-publish` with no
  stored token. The first publish was done manually with a token (below).

## Procedure

1. **Bump the version** in `server/python/pyproject.toml` (`[project].version`). PyPI is
   immutable — a published version can never be reused, so RC suffixes (`0.7.1rc1`) are
   the way to test a release shape.
2. **Build:** `cd server/python && rm -rf dist && uv build`.
3. **Validate:** `uvx twine check dist/*` (metadata + README render). Confirm the wheel
   ships `LICENSE` + `py.typed` and excludes `tests/` and `KNOWN_GAPS.md`.
4. **Test suite green:** `uv run --extra dev pytest -q`.
5. **TestPyPI dry run:** `uv publish --publish-url https://test.pypi.org/legacy/ dist/*`,
   then install into a throwaway venv from `https://test.pypi.org/simple/` (with
   `--extra-index-url https://pypi.org/simple/` for deps) and import-smoke it.
6. **Publish:** `uv publish dist/*`. **Irreversible once it returns.**
7. **Verify:** `curl -s https://pypi.org/pypi/metaobjects/json | grep version`; clean-venv
   `pip install metaobjects==<ver>` and import-smoke.

## Gotchas

- **PyPI immutability** — same as npm. Use TestPyPI + RC versions to rehearse.
- **PEP 639 license** — `license = "Apache-2.0"` (SPDX) + `license-files = ["LICENSE"]`;
  do NOT also add a `License ::` classifier (modern backends reject both).
- **README is the project page** — keep links absolute; relative `../../` links break.
- **LICENSE must be bundled** — `server/python/LICENSE` is a copy of the repo-root file so
  it ships in the sdist/wheel.
```

- [ ] **Step 2: Commit**

```bash
git add docs/RELEASING-python.md
git commit -m "docs: add RELEASING-python.md (PyPI release procedure)"
```

---

## Post-release notes

- **No SNAPSHOT-style post-bump** (unlike Maven). The git tree stays at `0.7.0` until the
  next intentional bump; Python has no `-SNAPSHOT` convention.
- **Push to origin** after the release commits land: `git push origin main` (fast-forward;
  main is shared/forward-only — never force).
- This unblocks fixing the repo README quickstart for Python (WS3/WS4) to reference the
  now-real `pip install metaobjects`.

## Self-review

- **Spec coverage (WS2 in the GTM spec):** fill pyproject metadata (Task 2), PyPI-correct
  README (Task 3), TestPyPI dry run (Task 5), trusted-publishing recommendation (Task 8),
  `docs/RELEASING-python.md` (Task 8), first publish at 0.7.0 (Task 6) — all covered.
- **Placeholders:** none — every file edit shows exact content; every verification shows
  exact command + expected output.
- **Consistency:** version `0.7.0` and dist name `metaobjects` used identically across
  Tasks 2–8; `LoadResult.root`/`.errors` in the README match the verified source API;
  `license`/`license-files` form consistent between pyproject (Task 2) and RELEASING doc
  (Task 8).
