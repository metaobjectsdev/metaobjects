# Cross-Port templateGenerator — Plan 1: Python Port

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `template_generator()` in the Python port + a conformance adapter that runs the Plan-0 corpus byte-equivalently.

**Architecture:** Mirrors the TS factory (`templateGenerator()`) in idiomatic Python. The factory returns an object satisfying the existing `Generator` Protocol at `metaobjects.codegen.generator.Generator`. Walk callback returns a list of `(data, output_path)` tuples; the factory renders the shared Mustache template via the existing `render()` engine and emits `list[EmittedFile]`. No CLI integration (Python codegen is programmatic only — see Plan-0 survey).

**Tech Stack:** Python 3.10+ / pytest / metaobjects.render.renderer (existing) / metaobjects.codegen.generator (existing).

**Scope boundary:** Python factory + Python conformance adapter only. C# (Plan 2) and Java (Plan 3) follow.

---

## File Structure

**New:**
- `server/python/src/metaobjects/codegen/generators/template_generator.py` — the factory (~50 LOC)
- `server/python/tests/codegen/test_template_generator.py` — unit tests (per-entity, aggregator, provider override)
- `server/python/tests/conformance/test_template_generator_conformance.py` — conformance adapter against the Plan-0 corpus

**No modification** to existing files (no CLI registration, no exports change). The factory is consumable directly via `from metaobjects.codegen.generators.template_generator import template_generator`.

---

## Task 1: Factory unit test — per-entity walk (failing test)

**Files:**
- Create: `server/python/tests/codegen/test_template_generator.py`

- [ ] **Step 1: Write the failing test**

```python
# Coverage for the Python templateGenerator() factory — mirrors
# server/typescript/packages/codegen-ts/test/generators/template-generator.test.ts.

import pytest
from metaobjects.codegen.generator import GenContext, GenConfig
from metaobjects.codegen.generators.template_generator import template_generator
from metaobjects.render.verify import InMemoryProvider
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.shared.meta_root import MetaRoot
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.shared.base_types import TYPE_METADATA, TYPE_OBJECT, TYPE_FIELD
from metaobjects.meta.shared.structural import SUBTYPE_ROOT
from metaobjects.meta.core.object.object_constants import OBJECT_SUBTYPE_ENTITY


def _build_root() -> MetaRoot:
    root = MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, "test")
    post = MetaObject(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY, "Post")
    post.add_child(MetaField(TYPE_FIELD, fc.FIELD_SUBTYPE_LONG, "id"))
    post.add_child(MetaField(TYPE_FIELD, fc.FIELD_SUBTYPE_STRING, "title"))
    root.add_child(post)
    return root


def _make_ctx(root: MetaRoot) -> GenContext:
    return GenContext(
        entities=[c for c in root.children if isinstance(c, MetaObject)],
        loaded_root=root,
        matches=lambda e: True,
        config=GenConfig(out_dir="/tmp"),
        warn=lambda m: None,
    )


def test_per_entity_walk_emits_one_file_per_entity():
    provider = InMemoryProvider({"custom/hello": "Hello {{name}}!\n"})
    root = _build_root()
    gen = template_generator(
        name="hello",
        template="custom/hello",
        provider=provider,
        walk=lambda r: [
            {"data": {"name": e.name}, "output_path": f"{e.name}.txt"}
            for e in r.children
            if isinstance(e, MetaObject)
        ],
    )
    files = gen.generate(_make_ctx(root))
    assert len(files) == 1
    assert files[0].path == "Post.txt"
    assert files[0].content == "Hello Post!\n"
```

- [ ] **Step 2: Verify TYPE_OBJECT / TYPE_FIELD / TYPE_METADATA / SUBTYPE_ROOT / OBJECT_SUBTYPE_ENTITY constants exist before running**

Run: `cd <repo-root>/server/python && python3 -c "from metaobjects.meta.shared.base_types import TYPE_METADATA, TYPE_OBJECT, TYPE_FIELD; from metaobjects.meta.shared.structural import SUBTYPE_ROOT; from metaobjects.meta.core.object.object_constants import OBJECT_SUBTYPE_ENTITY; print('OK')"`

Expected: `OK`. If any import fails, the survey was off — open `server/python/src/metaobjects/meta/shared/base_types.py` and `structural.py` to find correct paths, fix imports in the test.

- [ ] **Step 3: Run test to verify it fails (factory doesn't exist yet)**

Run: `cd <repo-root>/server/python && python3 -m pytest tests/codegen/test_template_generator.py::test_per_entity_walk_emits_one_file_per_entity -v`

Expected: FAIL — `ModuleNotFoundError: No module named 'metaobjects.codegen.generators.template_generator'`

---

## Task 2: Implement the factory (minimal — just enough for Task 1's test to pass)

**Files:**
- Create: `server/python/src/metaobjects/codegen/generators/template_generator.py`

- [ ] **Step 1: Write the factory**

```python
"""templateGenerator() — Python port of the TS rc.12 factory.

Walks the loaded MetaRoot → renders shared Mustache templates via the
metaobjects.render engine → returns EmittedFile[]. Same Generator Protocol
as the per-entity hand-coded generators; just adds the "Mustache template"
+ "walk that yields a data dict per output" primitives.

Design: docs/superpowers/specs / spec/design-docs/2026-05-28-cross-port-template-generator.md.
Cross-port byte-equivalence verified via fixtures/render-conformance/template-generator/.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Iterable, Sequence

from metaobjects.codegen.generator import EmittedFile, GenContext, Generator
from metaobjects.render import escapers
from metaobjects.render.renderer import RenderRequest, render
from metaobjects.render.verify import Provider


@dataclass
class _TemplateGenerator:
    name: str
    template: str
    walk: Callable[[Any], Sequence[dict]]
    provider: Provider
    format: str = escapers.FORMAT_TEXT

    def generate(self, ctx: GenContext) -> list[EmittedFile]:
        walk_results: Iterable[dict] = self.walk(ctx.loaded_root)
        files: list[EmittedFile] = []
        for entry in walk_results:
            content = render(
                RenderRequest(
                    payload=entry["data"],
                    provider=self.provider,
                    ref=self.template,
                    format=self.format,
                )
            )
            files.append(EmittedFile(path=entry["output_path"], content=content))
        return files


def template_generator(
    *,
    name: str,
    template: str,
    walk: Callable[[Any], Sequence[dict]],
    provider: Provider,
    format: str = escapers.FORMAT_TEXT,
) -> Generator:
    """Build a Generator that renders a Mustache template per walk entry.

    Args:
        name: kebab-case identifier; surfaces in diagnostics.
        template: ref resolved by the provider (e.g. "custom/hello").
        walk: callback that takes the loaded MetaRoot and returns a list of
            dicts shaped {"data": <payload>, "output_path": <relative path>}.
        provider: ref-resolver for the template (InMemoryProvider is fine
            for tests; production callers wire whatever Provider fits).
        format: render format ("text", "html", "markdown", etc. — drives
            escaping). Defaults to "text".
    """
    return _TemplateGenerator(
        name=name,
        template=template,
        walk=walk,
        provider=provider,
        format=format,
    )
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd <repo-root>/server/python && python3 -m pytest tests/codegen/test_template_generator.py::test_per_entity_walk_emits_one_file_per_entity -v`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
cd <repo-root>
git add server/python/src/metaobjects/codegen/generators/template_generator.py \
        server/python/tests/codegen/test_template_generator.py
git commit -m "feat(py-codegen): template_generator() factory (per-entity walk)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Aggregator-pattern test

**Files:**
- Modify: `server/python/tests/codegen/test_template_generator.py` — append test

- [ ] **Step 1: Append the aggregator test**

```python
def test_aggregator_walk_emits_single_file_from_all_entities():
    provider = InMemoryProvider({
        "custom/index": "Entities:\n{{#entities}}- {{name}}\n{{/entities}}",
    })
    root = _build_root()
    # Add a second entity
    comment = MetaObject(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY, "Comment")
    comment.add_child(MetaField(TYPE_FIELD, fc.FIELD_SUBTYPE_LONG, "id"))
    root.add_child(comment)

    gen = template_generator(
        name="index",
        template="custom/index",
        provider=provider,
        walk=lambda r: [{
            "data": {
                "entities": [
                    {"name": e.name}
                    for e in r.children
                    if isinstance(e, MetaObject)
                ]
            },
            "output_path": "index.txt",
        }],
    )
    files = gen.generate(_make_ctx(root))
    assert len(files) == 1
    assert files[0].path == "index.txt"
    assert files[0].content == "Entities:\n- Post\n- Comment\n"
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd <repo-root>/server/python && python3 -m pytest tests/codegen/test_template_generator.py::test_aggregator_walk_emits_single_file_from_all_entities -v`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
cd <repo-root>
git add server/python/tests/codegen/test_template_generator.py
git commit -m "test(py-codegen): aggregator-pattern test for template_generator

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Format-driven escaping test (html escapes, text doesn't)

**Files:**
- Modify: `server/python/tests/codegen/test_template_generator.py` — append test

- [ ] **Step 1: Append the format test**

```python
def test_format_text_does_not_escape_html():
    provider = InMemoryProvider({"custom/raw": "{{snippet}}\n"})
    root = _build_root()
    gen = template_generator(
        name="raw-text",
        template="custom/raw",
        provider=provider,
        format=escapers.FORMAT_TEXT,
        walk=lambda r: [{
            "data": {"snippet": "<p>hi</p>"},
            "output_path": "out.txt",
        }],
    )
    files = gen.generate(_make_ctx(root))
    assert files[0].content == "<p>hi</p>\n"


def test_format_html_escapes_html_in_payload():
    provider = InMemoryProvider({"custom/raw": "{{snippet}}\n"})
    root = _build_root()
    gen = template_generator(
        name="raw-html",
        template="custom/raw",
        provider=provider,
        format=escapers.FORMAT_HTML,
        walk=lambda r: [{
            "data": {"snippet": "<p>hi</p>"},
            "output_path": "out.html",
        }],
    )
    files = gen.generate(_make_ctx(root))
    # HTML format escapes — exact escape strategy is render-conformance
    # territory, but the output MUST NOT be byte-equal to the raw payload.
    assert files[0].content != "<p>hi</p>\n"
    assert "&lt;" in files[0].content or "&#60;" in files[0].content
```

- [ ] **Step 2: Run to verify both pass**

Run: `cd <repo-root>/server/python && python3 -m pytest tests/codegen/test_template_generator.py -v`

Expected: 4 tests PASS (per-entity + aggregator + two format tests).

- [ ] **Step 3: Commit**

```bash
cd <repo-root>
git add server/python/tests/codegen/test_template_generator.py
git commit -m "test(py-codegen): format-driven escaping coverage for template_generator

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Conformance adapter — runs Plan-0 corpus byte-equivalently

**Files:**
- Create: `server/python/tests/conformance/test_template_generator_conformance.py`
- Create: `server/python/tests/conformance/__init__.py` (if missing)

- [ ] **Step 1: Confirm `tests/conformance/` exists or create init**

Run: `ls server/python/tests/conformance/__init__.py 2>/dev/null || echo "needs init"`

If "needs init": `touch server/python/tests/conformance/__init__.py` (empty file).

- [ ] **Step 2: Write the conformance adapter**

```python
"""Cross-port byte-equivalence harness for the Python template_generator().

Mirrors the TS reference adapter:
server/typescript/packages/codegen-ts/test/conformance/template-generator-conformance.test.ts

Fixture format: fixtures/render-conformance/template-generator/README.md
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from metaobjects.codegen.generator import GenContext, GenConfig
from metaobjects.codegen.generators.template_generator import template_generator
from metaobjects.render import escapers
from metaobjects.render.verify import InMemoryProvider
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.shared.meta_root import MetaRoot
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.shared.base_types import TYPE_METADATA, TYPE_OBJECT, TYPE_FIELD
from metaobjects.meta.shared.structural import SUBTYPE_ROOT
from metaobjects.meta.core.object.object_constants import OBJECT_SUBTYPE_ENTITY


def _find_corpus() -> Path:
    p = Path(__file__).resolve()
    while p != p.parent:
        candidate = p / "fixtures" / "render-conformance" / "template-generator"
        if candidate.is_dir():
            return candidate
        p = p.parent
    raise RuntimeError("fixtures/render-conformance/template-generator not found")


_CORPUS = _find_corpus()

_FIELD_TYPE_MAP = {
    "string": fc.FIELD_SUBTYPE_STRING,
    "long": fc.FIELD_SUBTYPE_LONG,
    "int": fc.FIELD_SUBTYPE_INT,
    "double": fc.FIELD_SUBTYPE_DOUBLE,
    "boolean": fc.FIELD_SUBTYPE_BOOLEAN,
    "date": fc.FIELD_SUBTYPE_DATE,
}

_FORMAT_MAP = {
    "text": escapers.FORMAT_TEXT,
    "html": escapers.FORMAT_HTML,
    "markdown": escapers.FORMAT_MARKDOWN,
    "xml": escapers.FORMAT_XML,
    "csv": escapers.FORMAT_CSV,
    "json": escapers.FORMAT_JSON,
}


def _build_root_from_meta(meta: dict[str, Any]) -> MetaRoot:
    root = MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, "conformance")
    for e in meta["entities"]:
        obj = MetaObject(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY, e["name"])
        for f in e["fields"]:
            subtype = _FIELD_TYPE_MAP.get(f["type"])
            if subtype is None:
                raise ValueError(f"Unknown field type {f['type']!r}")
            obj.add_child(MetaField(TYPE_FIELD, subtype, f["name"]))
        root.add_child(obj)
    return root


def _fixtures() -> list[Path]:
    return sorted(p for p in _CORPUS.iterdir() if p.is_dir() and p.name.startswith("fixture-"))


def _collect_expected(fixture_dir: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    root = fixture_dir / "expected"
    if not root.is_dir():
        return out
    for path in sorted(root.rglob("*")):
        if path.is_file():
            out[str(path.relative_to(root))] = path.read_text(encoding="utf-8")
    return out


@pytest.mark.parametrize("fixture_dir", _fixtures(), ids=lambda p: p.name)
def test_template_generator_conformance(fixture_dir: Path) -> None:
    meta = json.loads((fixture_dir / "meta.json").read_text(encoding="utf-8"))
    template_body = (fixture_dir / "template.mustache").read_text(encoding="utf-8")
    walk_entries = json.loads((fixture_dir / "walk.json").read_text(encoding="utf-8"))
    expected = _collect_expected(fixture_dir)

    root = _build_root_from_meta(meta)
    by_name = {e.name for e in root.children if isinstance(e, MetaObject)}
    for w in walk_entries:
        if w.get("entity") is not None and w["entity"] not in by_name:
            raise AssertionError(f"walk.json references unknown entity {w['entity']!r}")

    provider = InMemoryProvider({"conformance/template": template_body})
    gen = template_generator(
        name=fixture_dir.name,
        template="conformance/template",
        provider=provider,
        format=_FORMAT_MAP[meta["format"]],
        walk=lambda r: [
            {"data": w["data"], "output_path": w["outputPath"]} for w in walk_entries
        ],
    )
    ctx = GenContext(
        entities=[c for c in root.children if isinstance(c, MetaObject)],
        loaded_root=root,
        matches=lambda e: True,
        config=GenConfig(out_dir="/tmp"),
        warn=lambda m: None,
    )
    files = gen.generate(ctx)

    emitted = {f.path: f.content for f in files}
    assert sorted(emitted.keys()) == sorted(w["outputPath"] for w in walk_entries)

    for w in walk_entries:
        path = w["outputPath"]
        assert path in expected, f"expected/{path} missing from fixture {fixture_dir.name}"
        assert emitted[path] == expected[path], (
            f"byte-equivalence failure in {fixture_dir.name}: {path}\n"
            f"--- expected ---\n{expected[path]!r}\n--- actual ---\n{emitted[path]!r}"
        )
```

- [ ] **Step 3: Run conformance suite**

Run: `cd <repo-root>/server/python && python3 -m pytest tests/conformance/test_template_generator_conformance.py -v`

Expected: 3 parametrized tests pass (fixture-001, fixture-002, fixture-003), one per fixture directory.

If a test fails:
- "Unknown field type" → the fixture's `meta.json` uses a field type not in `_FIELD_TYPE_MAP`; add it.
- "byte-equivalence failure" → Python's render output differs from the corpus's `expected/<file>`. This is a real cross-port discrepancy — check whether Mustache impl-specific behavior (whitespace, escaping) explains it, or whether the TS-generated expected file has a Mustache-spec-violating quirk. Either fix the fixture or the Python adapter. Do NOT blanket "accept actual" — that defeats the conformance purpose.

- [ ] **Step 4: Commit**

```bash
cd <repo-root>
git add server/python/tests/conformance/
git commit -m "test(py-conformance): template_generator cross-port byte-equivalence harness

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Regression check — full Python test suite

- [ ] **Step 1: Run all Python tests**

Run: `cd <repo-root>/server/python && python3 -m pytest -q 2>&1 | tail -5`

Expected: All pre-existing tests pass + the new 4 unit tests + the 3 conformance tests. No regressions.

If anything outside `tests/codegen/test_template_generator.py` or `tests/conformance/test_template_generator_conformance.py` fails: investigate. Plan 1 should not touch any other test surface.

- [ ] **Step 2: No commit** (read-only verification)

---

## Self-Review

**1. Spec coverage:**
- Per-port factory contract → Task 2 (matches TS opt names + idiom)
- Conformance via shared declarative fixtures → Task 5 (parametrized over Plan-0 corpus)
- Three walk patterns → covered transitively (fixture-001 per-entity, fixture-002 aggregator, fixture-003 filter-driven — the adapter doesn't care about pattern, just emits what walk.json declares)
- Render layer integration → factory uses existing `metaobjects.render.renderer.render()` (no new render code)
- Generator Protocol integration → factory satisfies the existing `Generator` Protocol (no Protocol changes)
- CLI integration → out of scope per design (Python codegen is programmatic only)

**2. Placeholder scan:** Searched for "TBD", "TODO", "fill in", "implement later", "similar to". None present. Every step has executable content or a runnable command with expected output.

**3. Type consistency:**
- `_TemplateGenerator` dataclass fields match `template_generator()` kwargs: `name, template, walk, provider, format`.
- Walk entry dict keys are `"data"` + `"output_path"` (snake-case, Python idiom) everywhere.
- Conformance adapter reads `walk.json`'s `"outputPath"` (camelCase, fixture wire format) and remaps to `"output_path"` for the walk callback. This intentional shape boundary keeps fixtures language-agnostic.
- `GenContext` construction passes `entities=[...for MetaObject child]`, matching survey finding.
- `GenConfig(out_dir="/tmp")` matches survey-confirmed constructor.

No drift between tasks.
