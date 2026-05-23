# Python Loader + Conformance — Phase 1 (Foundation + first green slice) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Python `metaobjects` package — the extensibility seam (registry + provider + node base with behavior on the class), a conformance runner over the shared corpus with an expected-failures ledger (CI green from commit #1), and the minimal parser/serializer/loader that turns the four simplest `loader-basic-*` + `smoke-empty-metadata` fixtures green.

**Architecture:** Open-Closed typed nodes (ADR-0002): value behavior lives on `MetaAttr`/`MetaField` classes; attributes are fully materialized as instances; the parser owns inline-vs-child syntax. Constants are colocated per concern (ADR-0003). Types register via composable providers with a topo-sorted `compose_registry` (ADR-0004); subtypes self-register via a decorator. The conformance corpus at `fixtures/conformance/` is the oracle; a ledger seeded with all fixtures as known-gaps keeps CI green while slices land.

**Tech Stack:** Python 3.11+, `uv` + `pyproject.toml` (hatchling), src-layout, `pytest` + `mypy`, **zero runtime dependencies** (stdlib `json` only).

**Reference (read before/while implementing):** `docs/superpowers/specs/2026-05-23-python-loader-conformance-design.md`, `spec/cross-language-porting-guide.md` (§3 pipeline, §5 gotchas), `spec/conformance-tests.md` (canonical serializer contract), ADR-0002/0003/0004. For *pipeline behavior* read the TS reference at `server/typescript/packages/metadata/`; for *extensibility structure* read Java at `server/java/metadata/`. **Do not mirror C# loader internals — they are stale (pre-2026-05 refactor).**

**Out of scope for Phase 1** (later phases): overlay merge, deferred super-resolution, the six validation passes, sources/origins/relationships, the `script.json` fixture, the Open-Closed proof test. The pipeline is built so these slot in later without rework.

**Conventions for every task below:** all commands run from `server/python/` unless stated. The corpus root is resolved by walking up from the test file to `<repo-root>/fixtures/conformance` — never hardcode an absolute/home path (public repo).

---

### Task 1: Project scaffold (uv, pyproject, src-layout)

**Files:**
- Create: `server/python/pyproject.toml`
- Create: `server/python/src/metaobjects/__init__.py`
- Create: `server/python/tests/__init__.py`
- Create: `server/python/tests/unit/__init__.py`
- Create: `server/python/tests/unit/test_smoke.py`
- Modify: `server/python/README.md`
- Note: the existing spike at `server/python/metaobjects/` and `server/python/test_spike.py` is superseded by `src/metaobjects/`; leave it in place for now — Task 6 carries its node-model behavior forward, and a later cleanup task deletes it.

- [ ] **Step 1: Write `pyproject.toml`**

```toml
[project]
name = "metaobjects"
version = "0.0.1"
description = "Python implementation of the MetaObjects metadata standard (loader + conformance)."
requires-python = ">=3.11"
dependencies = []

[project.optional-dependencies]
dev = ["pytest>=8", "mypy>=1.10"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/metaobjects"]

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["src"]

[tool.mypy]
python_version = "3.11"
strict = true
files = ["src/metaobjects"]
```

- [ ] **Step 2: Write a trivial smoke test so the runner has something to run**

`tests/unit/test_smoke.py`:
```python
def test_package_imports() -> None:
    import metaobjects

    assert metaobjects is not None
```

`src/metaobjects/__init__.py`:
```python
"""metaobjects — Python implementation of the MetaObjects standard."""
```

Create empty `tests/__init__.py` and `tests/unit/__init__.py`.

- [ ] **Step 3: Run the test (and create the venv)**

Run: `uv run --extra dev pytest -q`
Expected: `1 passed`.

- [ ] **Step 4: Run mypy**

Run: `uv run --extra dev mypy`
Expected: `Success: no issues found in 1 source file` (or similar).

- [ ] **Step 5: Update README**

Replace `server/python/README.md` body with:
```markdown
# MetaObjects — Python

Python implementation of the MetaObjects standard. Current scope: metadata **loader** +
**conformance** runner over the shared corpus (`../../fixtures/conformance/`). Codegen and
runtime are out of scope (see the design doc).

## Develop

```
uv run --extra dev pytest        # run tests + the conformance corpus
uv run --extra dev mypy          # type-check
```

Design: `docs/superpowers/specs/2026-05-23-python-loader-conformance-design.md`.
Porting method + contracts: `spec/cross-language-porting-guide.md`, ADR-0002/0003/0004.
```

- [ ] **Step 6: Commit**

```bash
cd server/python
git add pyproject.toml src/metaobjects/__init__.py tests/ README.md
git commit -m "feat(python): scaffold metaobjects package (uv, src-layout, pytest, mypy)"
```

---

### Task 2: DataType enum + error vocabulary

**Files:**
- Create: `server/python/src/metaobjects/datatype.py`
- Create: `server/python/src/metaobjects/errors.py`
- Test: `server/python/tests/unit/test_errors.py`

- [ ] **Step 1: Write the failing test**

`tests/unit/test_errors.py`:
```python
import json
from pathlib import Path

from metaobjects.errors import ErrorCode, MetaError


def _corpus_codes() -> set[str]:
    root = Path(__file__).resolve()
    while not (root / "fixtures" / "conformance").is_dir():
        assert root != root.parent, "could not locate fixtures/conformance"
        root = root.parent
    raw = json.loads((root / "fixtures" / "conformance" / "ERROR-CODES.json").read_text())
    return set(raw["codes"].keys())


def test_error_code_enum_covers_corpus_codes() -> None:
    defined = {c.name for c in ErrorCode}
    missing = _corpus_codes() - defined
    assert not missing, f"ErrorCode is missing corpus codes: {sorted(missing)}"


def test_meta_error_carries_code() -> None:
    err = MetaError("bad thing", ErrorCode.ERR_UNKNOWN_TYPE)
    assert err.code is ErrorCode.ERR_UNKNOWN_TYPE
    assert err.message == "bad thing"
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `uv run --extra dev pytest tests/unit/test_errors.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'metaobjects.errors'`.

- [ ] **Step 3: Implement `datatype.py`**

```python
"""Coarse value-type classification shared across nodes."""
from __future__ import annotations

from enum import Enum


class DataType(str, Enum):
    STRING = "string"
    INT = "int"
    LONG = "long"
    DOUBLE = "double"
    BOOLEAN = "boolean"
    DATE = "date"
    OBJECT = "object"
    STRING_ARRAY = "stringArray"
```

- [ ] **Step 4: Implement `errors.py`** (enum names must equal the keys in `ERROR-CODES.json`)

```python
"""Stable error/warning vocabulary. Codes (not messages) are the conformance contract."""
from __future__ import annotations

from enum import Enum


class ErrorCode(str, Enum):
    ERR_MALFORMED_JSON = "ERR_MALFORMED_JSON"
    ERR_TOP_LEVEL_NOT_OBJECT = "ERR_TOP_LEVEL_NOT_OBJECT"
    ERR_UNKNOWN_TYPE = "ERR_UNKNOWN_TYPE"
    ERR_UNKNOWN_SUBTYPE = "ERR_UNKNOWN_SUBTYPE"
    ERR_MISSING_SUBTYPE = "ERR_MISSING_SUBTYPE"
    ERR_DUPLICATE_NAME = "ERR_DUPLICATE_NAME"
    ERR_UNRESOLVED_SUPER = "ERR_UNRESOLVED_SUPER"
    ERR_INVALID_SUBTYPE_CHILD = "ERR_INVALID_SUBTYPE_CHILD"
    ERR_UNKNOWN_ATTR = "ERR_UNKNOWN_ATTR"
    ERR_MISSING_REQUIRED_ATTR = "ERR_MISSING_REQUIRED_ATTR"
    ERR_BAD_ATTR_VALUE = "ERR_BAD_ATTR_VALUE"
    ERR_BAD_DEFAULT_SORT_FIELD = "ERR_BAD_DEFAULT_SORT_FIELD"
    ERR_PROVIDER_DEPENDENCY_CYCLE = "ERR_PROVIDER_DEPENDENCY_CYCLE"
    ERR_PROVIDER_DUPLICATE_ID = "ERR_PROVIDER_DUPLICATE_ID"
    ERR_PROVIDER_MISSING_DEPENDENCY = "ERR_PROVIDER_MISSING_DEPENDENCY"
    ERR_PROVIDER_ATTR_CONFLICT = "ERR_PROVIDER_ATTR_CONFLICT"
    ERR_SUBTYPE_RULE_VIOLATION = "ERR_SUBTYPE_RULE_VIOLATION"
    ERR_OVERLAY_NO_TARGET = "ERR_OVERLAY_NO_TARGET"
    ERR_MALFORMED_YAML = "ERR_MALFORMED_YAML"
    ERR_INVALID_ORIGIN = "ERR_INVALID_ORIGIN"
    ERR_BAD_ATTR_FILTER = "ERR_BAD_ATTR_FILTER"
    ERR_UNKNOWN = "ERR_UNKNOWN"


class MetaError:
    """A loader error. `code` is the conformance-compared value; `message` is human text."""

    def __init__(
        self,
        message: str,
        code: ErrorCode = ErrorCode.ERR_UNKNOWN,
        source: str | None = None,
        path: str | None = None,
    ) -> None:
        self.message = message
        self.code = code
        self.source = source
        self.path = path

    def __repr__(self) -> str:
        return f"MetaError({self.code.name}: {self.message!r})"


class ParseError(Exception):
    """Raised by the parser in strict mode; carries a code."""

    def __init__(self, message: str, code: ErrorCode = ErrorCode.ERR_UNKNOWN) -> None:
        super().__init__(message)
        self.code = code
```

- [ ] **Step 5: Run the tests**

Run: `uv run --extra dev pytest tests/unit/test_errors.py -q`
Expected: `2 passed`.

- [ ] **Step 6: Commit**

```bash
git add src/metaobjects/datatype.py src/metaobjects/errors.py tests/unit/test_errors.py
git commit -m "feat(python): DataType enum + ErrorCode vocabulary (matches corpus ERROR-CODES.json)"
```

---

### Task 3: Shared structural constants (colocated, no god file)

**Files:**
- Create: `server/python/src/metaobjects/shared/__init__.py`
- Create: `server/python/src/metaobjects/shared/structural.py`
- Create: `server/python/src/metaobjects/shared/separators.py`
- Create: `server/python/src/metaobjects/shared/base_types.py`
- Test: `server/python/tests/unit/test_shared_constants.py`

- [ ] **Step 1: Write the failing test**

`tests/unit/test_shared_constants.py`:
```python
from metaobjects.shared.base_types import (
    SUBTYPE_BASE,
    TYPE_ATTR,
    TYPE_FIELD,
    TYPE_IDENTITY,
    TYPE_METADATA,
    TYPE_OBJECT,
)
from metaobjects.shared.separators import ATTR_PREFIX, PACKAGE_SEP
from metaobjects.shared.structural import KEY_CHILDREN, KEY_NAME, KEY_PACKAGE


def test_separators() -> None:
    assert ATTR_PREFIX == "@"
    assert PACKAGE_SEP == "::"


def test_structural_keys() -> None:
    assert (KEY_NAME, KEY_PACKAGE, KEY_CHILDREN) == ("name", "package", "children")


def test_base_type_names() -> None:
    assert TYPE_METADATA == "metadata"
    assert TYPE_OBJECT == "object"
    assert TYPE_FIELD == "field"
    assert TYPE_ATTR == "attr"
    assert TYPE_IDENTITY == "identity"
    assert SUBTYPE_BASE == "base"
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `uv run --extra dev pytest tests/unit/test_shared_constants.py -q`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Implement the shared modules**

`src/metaobjects/shared/__init__.py`: empty file.

`src/metaobjects/shared/separators.py`:
```python
"""Structural separators shared across the metamodel (Tier-1 vocabulary)."""
ATTR_PREFIX = "@"
PACKAGE_SEP = "::"
FUSED_KEY_SEP = "."
```

`src/metaobjects/shared/structural.py`:
```python
"""Reserved structural body keys (NOT @-attrs). Documented order in conformance-tests.md."""
KEY_NAME = "name"
KEY_PACKAGE = "package"
KEY_EXTENDS = "extends"
KEY_ABSTRACT = "abstract"
KEY_OVERLAY = "overlay"
KEY_IS_ARRAY = "isArray"
KEY_CHILDREN = "children"
```

`src/metaobjects/shared/base_types.py`:
```python
"""The base metamodel type names + the shared base/root subtype names."""
TYPE_METADATA = "metadata"
TYPE_OBJECT = "object"
TYPE_FIELD = "field"
TYPE_ATTR = "attr"
TYPE_VALIDATOR = "validator"
TYPE_IDENTITY = "identity"
TYPE_RELATIONSHIP = "relationship"
TYPE_VIEW = "view"
TYPE_LAYOUT = "layout"
TYPE_SOURCE = "source"
TYPE_ORIGIN = "origin"

SUBTYPE_BASE = "base"
SUBTYPE_ROOT = "root"
```

- [ ] **Step 4: Run the tests**

Run: `uv run --extra dev pytest tests/unit/test_shared_constants.py -q`
Expected: `3 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/metaobjects/shared/ tests/unit/test_shared_constants.py
git commit -m "feat(python): colocated shared constants (structural keys, separators, base types)"
```

---

### Task 4: Type registry (TypeRegistry, TypeDefinition, AttrSchema, ChildRule)

**Files:**
- Create: `server/python/src/metaobjects/registry.py`
- Test: `server/python/tests/unit/test_registry.py`

- [ ] **Step 1: Write the failing test**

`tests/unit/test_registry.py`:
```python
from metaobjects.registry import AttrSchema, ChildRule, TypeDefinition, TypeRegistry


def test_register_and_find() -> None:
    reg = TypeRegistry()
    base = TypeDefinition(
        type="field",
        sub_type="base",
        factory=lambda t, s, n: ("field", s, n),
        attrs=[AttrSchema(name="required", value_type="boolean")],
        child_rules=[ChildRule(child_type="attr", child_sub_type="*")],
    )
    reg.register(base)
    found = reg.find("field", "base")
    assert found is base
    assert reg.find("field", "missing") is None


def test_inherits_from_merges_attrs() -> None:
    reg = TypeRegistry()
    reg.register(
        TypeDefinition(
            type="field",
            sub_type="base",
            factory=lambda t, s, n: None,
            attrs=[AttrSchema(name="required", value_type="boolean")],
        )
    )
    reg.register(
        TypeDefinition(
            type="field",
            sub_type="string",
            factory=lambda t, s, n: None,
            attrs=[AttrSchema(name="maxLength", value_type="int")],
            inherits_from=("field", "base"),
        )
    )
    effective = reg.effective_attrs("field", "string")
    names = {a.name for a in effective}
    assert names == {"required", "maxLength"}
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `uv run --extra dev pytest tests/unit/test_registry.py -q`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Implement `registry.py`**

```python
"""The type registry: (type, subType) -> TypeDefinition. Populated by providers."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Optional


@dataclass(frozen=True)
class AttrSchema:
    name: str
    value_type: str  # an attr subtype name, e.g. "string", "boolean", "stringArray"
    required: bool = False
    allowed_values: tuple[str, ...] | None = None
    default: object | None = None


@dataclass(frozen=True)
class ChildRule:
    child_type: str
    child_sub_type: str  # "*" wildcard matches any subtype


# factory(type, sub_type, name) -> a node instance
NodeFactory = Callable[[str, str, str], object]


@dataclass
class TypeDefinition:
    type: str
    sub_type: str
    factory: NodeFactory
    attrs: list[AttrSchema] = field(default_factory=list)
    child_rules: list[ChildRule] = field(default_factory=list)
    inherits_from: Optional[tuple[str, str]] = None

    @property
    def key(self) -> tuple[str, str]:
        return (self.type, self.sub_type)


class TypeRegistry:
    def __init__(self) -> None:
        self._defs: dict[tuple[str, str], TypeDefinition] = {}

    def register(self, definition: TypeDefinition) -> None:
        self._defs[definition.key] = definition

    def find(self, type_: str, sub_type: str) -> TypeDefinition | None:
        return self._defs.get((type_, sub_type))

    def has_type(self, type_: str) -> bool:
        return any(t == type_ for (t, _s) in self._defs)

    def effective_attrs(self, type_: str, sub_type: str) -> list[AttrSchema]:
        """Own attrs plus those inherited via inherits_from; own wins on name conflict."""
        definition = self.find(type_, sub_type)
        if definition is None:
            return []
        by_name: dict[str, AttrSchema] = {}
        if definition.inherits_from is not None:
            for attr in self.effective_attrs(*definition.inherits_from):
                by_name[attr.name] = attr
        for attr in definition.attrs:
            by_name[attr.name] = attr
        return list(by_name.values())

    def attr_schema(self, type_: str, sub_type: str, attr_name: str) -> AttrSchema | None:
        for attr in self.effective_attrs(type_, sub_type):
            if attr.name == attr_name:
                return attr
        return None
```

- [ ] **Step 4: Run the tests**

Run: `uv run --extra dev pytest tests/unit/test_registry.py -q`
Expected: `2 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/metaobjects/registry.py tests/unit/test_registry.py
git commit -m "feat(python): TypeRegistry + TypeDefinition with inherits_from attr merging"
```

---

### Task 5: Provider model + compose_registry (the extensibility seam)

**Files:**
- Create: `server/python/src/metaobjects/provider.py`
- Test: `server/python/tests/unit/test_provider.py`

- [ ] **Step 1: Write the failing test**

`tests/unit/test_provider.py`:
```python
import pytest

from metaobjects.errors import ErrorCode, ParseError
from metaobjects.provider import Provider, compose_registry
from metaobjects.registry import TypeDefinition


def _def(type_: str, sub: str) -> TypeDefinition:
    return TypeDefinition(type=type_, sub_type=sub, factory=lambda t, s, n: (t, s, n))


def test_compose_runs_in_dependency_order() -> None:
    order: list[str] = []
    a = Provider("a", dependencies=("b",))
    b = Provider("b")
    a.add(_def("x", "a"))
    b.add(_def("x", "b"))
    a._on_register = lambda: order.append("a")  # type: ignore[attr-defined]
    b._on_register = lambda: order.append("b")  # type: ignore[attr-defined]
    reg = compose_registry([a, b])
    assert order == ["b", "a"]  # dependency b before dependent a
    assert reg.find("x", "a") is not None and reg.find("x", "b") is not None


def test_register_decorator_self_registers_a_class() -> None:
    p = Provider("core")

    @p.register
    class Widget:
        TYPE = "widget"
        SUBTYPE = "fancy"

    reg = compose_registry([p])
    assert reg.find("widget", "fancy") is not None


def test_duplicate_id_is_error() -> None:
    with pytest.raises(ParseError) as exc:
        compose_registry([Provider("dup"), Provider("dup")])
    assert exc.value.code is ErrorCode.ERR_PROVIDER_DUPLICATE_ID


def test_missing_dependency_is_error() -> None:
    with pytest.raises(ParseError) as exc:
        compose_registry([Provider("a", dependencies=("ghost",))])
    assert exc.value.code is ErrorCode.ERR_PROVIDER_MISSING_DEPENDENCY


def test_dependency_cycle_is_error() -> None:
    with pytest.raises(ParseError) as exc:
        compose_registry([Provider("a", dependencies=("b",)), Provider("b", dependencies=("a",))])
    assert exc.value.code is ErrorCode.ERR_PROVIDER_DEPENDENCY_CYCLE
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `uv run --extra dev pytest tests/unit/test_provider.py -q`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Implement `provider.py`**

The `@provider.register` decorator reads `TYPE`/`SUBTYPE` (and optional `ATTRS`, `CHILD_RULES`, `INHERITS_FROM`) class attributes and builds a `TypeDefinition` whose factory instantiates the class as `cls(type, sub_type, name)`.

```python
"""Composable type providers (ADR-0004). Subtypes self-register via @provider.register."""
from __future__ import annotations

from typing import Callable, TypeVar

from .errors import ErrorCode, ParseError
from .registry import AttrSchema, ChildRule, TypeDefinition, TypeRegistry

T = TypeVar("T", bound=type)


class Provider:
    def __init__(self, provider_id: str, dependencies: tuple[str, ...] = ()) -> None:
        self.id = provider_id
        self.dependencies = dependencies
        self._defs: list[TypeDefinition] = []
        self._on_register: Callable[[], None] | None = None

    def add(self, definition: TypeDefinition) -> None:
        self._defs.append(definition)

    def register(self, cls: T) -> T:
        """Class decorator: build a TypeDefinition from class attributes and add it."""
        type_ = getattr(cls, "TYPE")
        sub_type = getattr(cls, "SUBTYPE")
        attrs: list[AttrSchema] = list(getattr(cls, "ATTRS", []))
        child_rules: list[ChildRule] = list(getattr(cls, "CHILD_RULES", []))
        inherits_from = getattr(cls, "INHERITS_FROM", None)

        def factory(t: str, s: str, n: str, _cls: T = cls) -> object:
            return _cls(t, s, n)  # type: ignore[call-arg]

        self.add(
            TypeDefinition(
                type=type_,
                sub_type=sub_type,
                factory=factory,
                attrs=attrs,
                child_rules=child_rules,
                inherits_from=inherits_from,
            )
        )
        return cls

    def register_types(self, registry: TypeRegistry) -> None:
        if self._on_register is not None:
            self._on_register()
        for definition in self._defs:
            registry.register(definition)


def compose_registry(providers: list[Provider]) -> TypeRegistry:
    """Topologically sort providers by dependency, then register each into a fresh registry."""
    ordered = _topo_sort(providers)
    registry = TypeRegistry()
    for provider in ordered:
        provider.register_types(registry)
    return registry


def _topo_sort(providers: list[Provider]) -> list[Provider]:
    by_id: dict[str, Provider] = {}
    for provider in providers:
        if provider.id in by_id:
            raise ParseError(
                f'Duplicate provider id "{provider.id}"', ErrorCode.ERR_PROVIDER_DUPLICATE_ID
            )
        by_id[provider.id] = provider

    for provider in providers:
        for dep in provider.dependencies:
            if dep not in by_id:
                raise ParseError(
                    f'Provider "{provider.id}" depends on missing "{dep}"',
                    ErrorCode.ERR_PROVIDER_MISSING_DEPENDENCY,
                )

    ordered: list[Provider] = []
    visited: dict[str, int] = {}  # 0 = visiting, 1 = done

    def visit(p: Provider) -> None:
        state = visited.get(p.id)
        if state == 1:
            return
        if state == 0:
            raise ParseError(
                f'Provider dependency cycle at "{p.id}"',
                ErrorCode.ERR_PROVIDER_DEPENDENCY_CYCLE,
            )
        visited[p.id] = 0
        for dep in p.dependencies:
            visit(by_id[dep])
        visited[p.id] = 1
        ordered.append(p)

    for provider in providers:
        visit(provider)
    return ordered
```

- [ ] **Step 4: Run the tests**

Run: `uv run --extra dev pytest tests/unit/test_provider.py -q`
Expected: `5 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/metaobjects/provider.py tests/unit/test_provider.py
git commit -m "feat(python): provider model + compose_registry topo-sort (ADR-0004 seam)"
```

---

### Task 6: MetaData base node (carry the spike forward, attrs as instances)

**Files:**
- Create: `server/python/src/metaobjects/meta/__init__.py`
- Create: `server/python/src/metaobjects/meta/meta_data.py`
- Create: `server/python/src/metaobjects/attr_class_map.py`
- Test: `server/python/tests/unit/test_meta_data.py`

The `attr_class_map` is a **dependency-free leaf module** (imports nothing from `meta/`) that maps an attr subtype → its `MetaAttr` class, plus a fallback. Attr subclasses self-register into it (Task 7). `MetaData.set_attr` uses it to materialize attribute instances — this breaks the import cycle (`meta_data` → attr class → `meta_data`).

- [ ] **Step 1: Write the failing test**

`tests/unit/test_meta_data.py`:
```python
from metaobjects.meta.meta_data import MetaData


class _Node(MetaData):
    """Concrete test node (MetaData is otherwise abstract-by-convention)."""


def test_fqn_uses_package() -> None:
    n = _Node("object", "entity", "Product")
    assert n.fqn() == "Product"
    n.package = "acme::commerce"
    assert n.fqn() == "acme::commerce::Product"


def test_children_and_freeze_gate() -> None:
    parent = _Node("object", "entity", "P")
    child = _Node("field", "long", "id")
    parent.add_child(child)
    assert [c.name for c in parent.children()] == ["id"]
    parent.freeze()
    assert parent.frozen and child.frozen
    try:
        parent.add_child(_Node("field", "string", "x"))
        raise AssertionError("expected mutation-after-freeze to raise")
    except RuntimeError:
        pass


def test_effective_children_super_chain_override() -> None:
    base = _Node("object", "entity", "Base")
    base.add_child(_Node("field", "long", "id"))
    sub = _Node("object", "entity", "Sub")
    sub.add_child(_Node("field", "string", "email"))
    sub.super_data = base
    names = [c.name for c in sub.effective_children()]
    assert names == ["id", "email"]
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `uv run --extra dev pytest tests/unit/test_meta_data.py -q`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Implement `attr_class_map.py`** (dependency-free)

```python
"""Dependency-free registry: attr subtype -> MetaAttr class. Breaks the meta-data import cycle."""
from __future__ import annotations

from typing import Callable

_ATTR_CLASSES: dict[str, Callable[..., object]] = {}
_FALLBACK: Callable[..., object] | None = None


def register_attr_class(sub_type: str, ctor: Callable[..., object]) -> None:
    _ATTR_CLASSES[sub_type] = ctor


def register_fallback_attr_class(ctor: Callable[..., object]) -> None:
    global _FALLBACK
    _FALLBACK = ctor


def attr_class_for(sub_type: str) -> Callable[..., object]:
    ctor = _ATTR_CLASSES.get(sub_type, _FALLBACK)
    if ctor is None:
        raise RuntimeError("attr classes not registered (import metaobjects.core_types first)")
    return ctor
```

- [ ] **Step 4: Implement `meta/meta_data.py`**

Attributes are stored as `MetaAttr` instances (materialized via `attr_class_for`). `set_attr(name, value, sub_type=None)` resolves the attr class, instantiates it, and lets it coerce its own value. Effective resolution walks `super_data`. `_cached` memoizes only after freeze.

```python
"""Abstract node base — Python port of the typed-tree MetaData (ADR-0002)."""
from __future__ import annotations

from typing import Callable, Optional, TypeVar

from ..attr_class_map import attr_class_for
from ..shared.base_types import SUBTYPE_BASE, TYPE_ATTR
from ..shared.separators import PACKAGE_SEP

T = TypeVar("T")


class MetaData:
    def __init__(self, type_: str, sub_type: str, name: str) -> None:
        self.type = type_
        self.sub_type = sub_type
        self.name = name
        self.package: Optional[str] = None
        self.super_ref: Optional[str] = None
        self.super_data: Optional[MetaData] = None
        self.is_abstract = False
        self.is_array = False
        self.parent: Optional[MetaData] = None
        self._attr_nodes: dict[str, MetaData] = {}  # name -> MetaAttr instance
        self._children: list[MetaData] = []
        self._cache: dict[str, object] = {}
        self._frozen = False

    @property
    def frozen(self) -> bool:
        return self._frozen

    def fqn(self) -> str:
        return self.name if not self.package else f"{self.package}{PACKAGE_SEP}{self.name}"

    def _require_mutable(self) -> None:
        if self._frozen:
            raise RuntimeError(f"Cannot mutate frozen MetaData {self.fqn()}")

    def set_attr(self, name: str, value: object, sub_type: str | None = None) -> None:
        self._require_mutable()
        ctor = attr_class_for(sub_type if sub_type is not None else SUBTYPE_BASE)
        attr = ctor(TYPE_ATTR, sub_type if sub_type is not None else SUBTYPE_BASE, name)
        attr.parent = self  # type: ignore[attr-defined]
        attr.set_value(value)  # type: ignore[attr-defined]
        self._attr_nodes[name] = attr  # type: ignore[assignment]

    def own_meta_attr(self, name: str) -> Optional[MetaData]:
        return self._attr_nodes.get(name)

    def own_meta_attrs(self) -> list[MetaData]:
        return list(self._attr_nodes.values())

    def attr(self, name: str) -> object:
        node = self._attr_nodes.get(name)
        return getattr(node, "value", None) if node is not None else None

    def add_child(self, child: "MetaData") -> None:
        self._require_mutable()
        child.parent = self
        self._children.append(child)

    def children(self) -> list["MetaData"]:
        return list(self._children)

    def effective_children(self) -> list["MetaData"]:
        def compute() -> list[MetaData]:
            result: list[MetaData] = list(
                self.super_data.effective_children() if self.super_data else []
            )
            for own in self._children:
                idx = next(
                    (i for i, c in enumerate(result)
                     if c.type == own.type and c.name == own.name),
                    None,
                )
                if idx is None:
                    result.append(own)
                else:
                    result[idx] = own
            return result

        return self._cached("effective_children", compute)

    def freeze(self) -> None:
        if self._frozen:
            return
        self._frozen = True
        for attr in self._attr_nodes.values():
            attr.freeze()
        for child in self._children:
            child.freeze()

    def _cached(self, key: str, compute: Callable[[], T]) -> T:
        if self._frozen and key in self._cache:
            return self._cache[key]  # type: ignore[return-value]
        value = compute()
        if self._frozen:
            self._cache[key] = value
        return value
```

- [ ] **Step 5: Run the tests** (they don't exercise `set_attr` yet, so the cycle isn't triggered)

Run: `uv run --extra dev pytest tests/unit/test_meta_data.py -q`
Expected: `3 passed`.

- [ ] **Step 6: Commit**

```bash
git add src/metaobjects/meta/__init__.py src/metaobjects/meta/meta_data.py src/metaobjects/attr_class_map.py tests/unit/test_meta_data.py
git commit -m "feat(python): MetaData base node (attrs as instances, effective children, freeze)"
```

---

### Task 7: MetaAttr base + StringArrayAttr (behavior on the class)

**Files:**
- Create: `server/python/src/metaobjects/meta/core/__init__.py`
- Create: `server/python/src/metaobjects/meta/core/attr/__init__.py`
- Create: `server/python/src/metaobjects/meta/core/attr/attr_constants.py`
- Create: `server/python/src/metaobjects/meta/core/attr/meta_attr.py`
- Test: `server/python/tests/unit/test_meta_attr.py`

- [ ] **Step 1: Write the failing test**

`tests/unit/test_meta_attr.py`:
```python
from metaobjects.meta.core.attr.attr_constants import (
    ATTR_SUBTYPE_BOOLEAN,
    ATTR_SUBTYPE_STRING,
    ATTR_SUBTYPE_STRINGARRAY,
)
from metaobjects.meta.core.attr.meta_attr import MetaAttr, StringArrayAttr


def test_string_attr_coerces_and_keeps_value() -> None:
    a = MetaAttr("attr", ATTR_SUBTYPE_STRING, "label")
    a.set_value("hi")
    assert a.value == "hi"


def test_boolean_attr_coerces() -> None:
    a = MetaAttr("attr", ATTR_SUBTYPE_BOOLEAN, "flag")
    a.set_value(True)
    assert a.value is True


def test_string_array_desugars_scalar_to_list() -> None:
    a = StringArrayAttr("attr", ATTR_SUBTYPE_STRINGARRAY, "fields")
    a.set_value("id")
    assert a.value == ["id"]
    b = StringArrayAttr("attr", ATTR_SUBTYPE_STRINGARRAY, "fields")
    b.set_value(["a", "b"])
    assert b.value == ["a", "b"]
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `uv run --extra dev pytest tests/unit/test_meta_attr.py -q`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Implement `attr_constants.py`** (colocated)

```python
"""Attribute subtype vocabulary (colocated with the attr node — ADR-0003)."""
from ...shared.base_types import SUBTYPE_BASE  # noqa: F401 (re-export convenience)

ATTR_SUBTYPE_STRING = "string"
ATTR_SUBTYPE_INT = "int"
ATTR_SUBTYPE_LONG = "long"
ATTR_SUBTYPE_DOUBLE = "double"
ATTR_SUBTYPE_BOOLEAN = "boolean"
ATTR_SUBTYPE_STRINGARRAY = "stringArray"

ATTR_SUBTYPES = (
    SUBTYPE_BASE,
    ATTR_SUBTYPE_STRING,
    ATTR_SUBTYPE_INT,
    ATTR_SUBTYPE_LONG,
    ATTR_SUBTYPE_DOUBLE,
    ATTR_SUBTYPE_BOOLEAN,
    ATTR_SUBTYPE_STRINGARRAY,
)
```

- [ ] **Step 4: Implement `meta_attr.py`** (behavior on the class; self-registers into the attr-class map)

```python
"""MetaAttr base + value-shaped subclasses. Value behavior lives here (ADR-0002)."""
from __future__ import annotations

from ....attr_class_map import register_attr_class, register_fallback_attr_class
from ....datatype import DataType
from ...meta_data import MetaData
from .attr_constants import (
    ATTR_SUBTYPE_BOOLEAN,
    ATTR_SUBTYPE_DOUBLE,
    ATTR_SUBTYPE_INT,
    ATTR_SUBTYPE_LONG,
    ATTR_SUBTYPE_STRING,
    ATTR_SUBTYPE_STRINGARRAY,
)

_SCALAR_DATA_TYPE = {
    ATTR_SUBTYPE_STRING: DataType.STRING,
    ATTR_SUBTYPE_INT: DataType.INT,
    ATTR_SUBTYPE_LONG: DataType.LONG,
    ATTR_SUBTYPE_DOUBLE: DataType.DOUBLE,
    ATTR_SUBTYPE_BOOLEAN: DataType.BOOLEAN,
}


class MetaAttr(MetaData):
    def __init__(self, type_: str, sub_type: str, name: str) -> None:
        super().__init__(type_, sub_type, name)
        self.value: object = None

    @property
    def data_type(self) -> DataType:
        return _SCALAR_DATA_TYPE.get(self.sub_type, DataType.STRING)

    def coerce(self, raw: object) -> object:
        """Base coercion: keep scalars as-is (the parser already produced JSON scalars)."""
        return raw

    def desugar(self, value: object) -> object:
        return value

    def set_value(self, raw: object) -> None:
        self._require_mutable()
        self.value = self.desugar(self.coerce(raw))


class StringArrayAttr(MetaAttr):
    @property
    def data_type(self) -> DataType:
        return DataType.STRING_ARRAY

    def coerce(self, raw: object) -> object:
        if isinstance(raw, list):
            return [str(el) for el in raw]
        if isinstance(raw, str):
            return [raw]  # degenerate scalar form -> single-element list
        return raw


register_fallback_attr_class(MetaAttr)
register_attr_class(ATTR_SUBTYPE_STRINGARRAY, StringArrayAttr)
```

Create empty `meta/core/__init__.py` and `meta/core/attr/__init__.py`.

- [ ] **Step 5: Run the tests**

Run: `uv run --extra dev pytest tests/unit/test_meta_attr.py -q`
Expected: `3 passed`.

- [ ] **Step 6: Commit**

```bash
git add src/metaobjects/meta/core/ tests/unit/test_meta_attr.py
git commit -m "feat(python): MetaAttr base + StringArrayAttr (value behavior on the class)"
```

---

### Task 8: Field, object, identity, root nodes + the core provider

**Files:**
- Create: `server/python/src/metaobjects/meta/core/field/__init__.py`, `field_constants.py`, `meta_field.py`
- Create: `server/python/src/metaobjects/meta/core/object/__init__.py`, `object_constants.py`, `meta_object.py`
- Create: `server/python/src/metaobjects/meta/core/identity/__init__.py`, `identity_constants.py`, `meta_identity.py`
- Create: `server/python/src/metaobjects/meta/meta_root.py`
- Create: `server/python/src/metaobjects/core_types.py`
- Test: `server/python/tests/unit/test_core_types.py`

- [ ] **Step 1: Write the failing test**

`tests/unit/test_core_types.py`:
```python
from metaobjects.core_types import core_provider
from metaobjects.provider import compose_registry


def test_core_provider_registers_phase1_types() -> None:
    reg = compose_registry([core_provider])
    for type_, sub in [
        ("metadata", "root"),
        ("object", "entity"),
        ("field", "long"),
        ("field", "string"),
        ("field", "int"),
        ("field", "boolean"),
        ("identity", "primary"),
    ]:
        assert reg.find(type_, sub) is not None, f"missing {type_}.{sub}"


def test_identity_primary_declares_fields_as_stringarray_required() -> None:
    reg = compose_registry([core_provider])
    schema = reg.attr_schema("identity", "primary", "fields")
    assert schema is not None
    assert schema.value_type == "stringArray"
    assert schema.required is True
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `uv run --extra dev pytest tests/unit/test_core_types.py -q`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Implement the node classes**

`meta/core/field/field_constants.py`:
```python
"""Field subtype vocabulary (colocated)."""
from ...meta_data import MetaData  # noqa: F401  (kept for module locality; not required)

FIELD_SUBTYPE_STRING = "string"
FIELD_SUBTYPE_INT = "int"
FIELD_SUBTYPE_LONG = "long"
FIELD_SUBTYPE_DOUBLE = "double"
FIELD_SUBTYPE_FLOAT = "float"
FIELD_SUBTYPE_BOOLEAN = "boolean"
FIELD_SUBTYPE_DATE = "date"

FIELD_SUBTYPES = (
    FIELD_SUBTYPE_STRING,
    FIELD_SUBTYPE_INT,
    FIELD_SUBTYPE_LONG,
    FIELD_SUBTYPE_DOUBLE,
    FIELD_SUBTYPE_FLOAT,
    FIELD_SUBTYPE_BOOLEAN,
    FIELD_SUBTYPE_DATE,
)
```

`meta/core/field/meta_field.py`:
```python
"""MetaField — data_type resolves by subtype (ADR-0002)."""
from __future__ import annotations

from ....datatype import DataType
from ...meta_data import MetaData
from . import field_constants as fc

_FIELD_DATA_TYPE = {
    fc.FIELD_SUBTYPE_STRING: DataType.STRING,
    fc.FIELD_SUBTYPE_INT: DataType.INT,
    fc.FIELD_SUBTYPE_LONG: DataType.LONG,
    fc.FIELD_SUBTYPE_DOUBLE: DataType.DOUBLE,
    fc.FIELD_SUBTYPE_FLOAT: DataType.DOUBLE,
    fc.FIELD_SUBTYPE_BOOLEAN: DataType.BOOLEAN,
    fc.FIELD_SUBTYPE_DATE: DataType.DATE,
}


class MetaField(MetaData):
    @property
    def data_type(self) -> DataType:
        return _FIELD_DATA_TYPE.get(self.sub_type, DataType.STRING)
```

`meta/core/object/object_constants.py`:
```python
"""Object subtype vocabulary (colocated)."""
OBJECT_SUBTYPE_ENTITY = "entity"
OBJECT_SUBTYPE_VALUE = "value"
OBJECT_SUBTYPES = (OBJECT_SUBTYPE_ENTITY, OBJECT_SUBTYPE_VALUE)
```

`meta/core/object/meta_object.py`:
```python
"""MetaObject — typed accessors over children."""
from __future__ import annotations

from ...meta_data import MetaData
from ..field.meta_field import MetaField


class MetaObject(MetaData):
    def fields(self) -> list[MetaField]:
        return [c for c in self.effective_children() if isinstance(c, MetaField)]
```

`meta/core/identity/identity_constants.py`:
```python
"""Identity subtype + attr vocabulary (colocated)."""
IDENTITY_SUBTYPE_PRIMARY = "primary"
IDENTITY_SUBTYPE_SECONDARY = "secondary"
IDENTITY_SUBTYPES = (IDENTITY_SUBTYPE_PRIMARY, IDENTITY_SUBTYPE_SECONDARY)

IDENTITY_ATTR_FIELDS = "fields"
```

`meta/core/identity/meta_identity.py`:
```python
"""MetaIdentity — primary/secondary."""
from __future__ import annotations

from ...meta_data import MetaData


class MetaIdentity(MetaData):
    pass
```

`meta/meta_root.py`:
```python
"""MetaRoot — the metadata.root node."""
from __future__ import annotations

from .meta_data import MetaData


class MetaRoot(MetaData):
    pass
```

Create empty `__init__.py` in `field/`, `object/`, `identity/`.

- [ ] **Step 4: Implement `core_types.py`** (the core provider; imports the attr module so its self-registration runs)

```python
"""The core metaobjects type provider. Composes per-concern registrations (ADR-0004)."""
from __future__ import annotations

# Importing the attr module triggers its attr-class self-registration (side effect).
from .meta.core.attr import meta_attr as _attr  # noqa: F401
from .meta.core.attr.attr_constants import ATTR_SUBTYPE_STRINGARRAY, ATTR_SUBTYPES
from .meta.core.field import field_constants as fc
from .meta.core.field.meta_field import MetaField
from .meta.core.identity.identity_constants import (
    IDENTITY_ATTR_FIELDS,
    IDENTITY_SUBTYPES,
)
from .meta.core.identity.meta_identity import MetaIdentity
from .meta.core.object.meta_object import MetaObject
from .meta.core.object.object_constants import OBJECT_SUBTYPES
from .meta.meta_root import MetaRoot
from .provider import Provider
from .registry import AttrSchema, ChildRule, TypeDefinition
from .shared.base_types import (
    SUBTYPE_BASE,
    SUBTYPE_ROOT,
    TYPE_ATTR,
    TYPE_FIELD,
    TYPE_IDENTITY,
    TYPE_METADATA,
    TYPE_OBJECT,
)

core_provider = Provider("metaobjects-core-types")

# metadata.root
core_provider.add(
    TypeDefinition(
        type=TYPE_METADATA,
        sub_type=SUBTYPE_ROOT,
        factory=lambda t, s, n: MetaRoot(t, s, n),
        child_rules=[ChildRule(TYPE_OBJECT, "*")],
    )
)

# object.* (entity, value)
for sub in OBJECT_SUBTYPES:
    core_provider.add(
        TypeDefinition(
            type=TYPE_OBJECT,
            sub_type=sub,
            factory=lambda t, s, n: MetaObject(t, s, n),
            child_rules=[
                ChildRule(TYPE_FIELD, "*"),
                ChildRule(TYPE_IDENTITY, "*"),
                ChildRule(TYPE_ATTR, "*"),
            ],
        )
    )

# field.* (one factory, data_type by subtype)
for sub in fc.FIELD_SUBTYPES:
    core_provider.add(
        TypeDefinition(
            type=TYPE_FIELD,
            sub_type=sub,
            factory=lambda t, s, n: MetaField(t, s, n),
            child_rules=[ChildRule(TYPE_ATTR, "*")],
        )
    )

# attr.* (factory resolved per subtype via the attr-class map at parse time; here register defs)
from .attr_class_map import attr_class_for  # noqa: E402

for sub in ATTR_SUBTYPES:
    core_provider.add(
        TypeDefinition(
            type=TYPE_ATTR,
            sub_type=sub,
            factory=(lambda t, s, n: attr_class_for(s)(t, s, n)),
        )
    )

# identity.* (primary/secondary); @fields is a required stringArray
_identity_attrs = [
    AttrSchema(name=IDENTITY_ATTR_FIELDS, value_type=ATTR_SUBTYPE_STRINGARRAY, required=True)
]
for sub in IDENTITY_SUBTYPES:
    core_provider.add(
        TypeDefinition(
            type=TYPE_IDENTITY,
            sub_type=sub,
            factory=lambda t, s, n: MetaIdentity(t, s, n),
            attrs=list(_identity_attrs),
            child_rules=[ChildRule(TYPE_ATTR, "*")],
        )
    )
```

- [ ] **Step 5: Run the tests**

Run: `uv run --extra dev pytest tests/unit/test_core_types.py -q`
Expected: `2 passed`. Also run the whole suite: `uv run --extra dev pytest -q` → all green.

- [ ] **Step 6: Commit**

```bash
git add src/metaobjects/meta/ src/metaobjects/core_types.py tests/unit/test_core_types.py
git commit -m "feat(python): field/object/identity/root nodes + core type provider"
```

---

### Task 9: Canonical JSON serializer

**Files:**
- Create: `server/python/src/metaobjects/serializer_json.py`
- Test: `server/python/tests/unit/test_serializer.py`

Canonical contract (`spec/conformance-tests.md`): each node is `{"<type>.<subType>": body}`; body key order is `name, package, extends, abstract, isArray, @-attrs (alphabetical), children (declaration order)`; absent/empty values omitted; `@`-attrs sorted alphabetically; whole-number floats emit as ints; 2-space indent; one trailing newline.

- [ ] **Step 1: Write the failing test**

`tests/unit/test_serializer.py`:
```python
import json

import metaobjects.core_types  # noqa: F401  (triggers attr-class registration for set_attr)
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.identity.meta_identity import MetaIdentity
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.meta_root import MetaRoot
from metaobjects.serializer_json import canonical_serialize


def test_empty_root() -> None:
    root = MetaRoot("metadata", "root", "")
    assert json.loads(canonical_serialize(root)) == {"metadata.root": {}}


def test_root_with_package_only() -> None:
    root = MetaRoot("metadata", "root", "")
    root.package = "acme"
    assert json.loads(canonical_serialize(root)) == {"metadata.root": {"package": "acme"}}


def test_entity_with_fields_and_identity_fields_array() -> None:
    root = MetaRoot("metadata", "root", "")
    root.package = "acme::commerce"
    obj = MetaObject("object", "entity", "Product")
    obj.add_child(MetaField("field", "long", "id"))
    obj.add_child(MetaField("field", "string", "name"))
    ident = MetaIdentity("identity", "primary", "")
    ident.set_attr("fields", "id", sub_type="stringArray")
    obj.add_child(ident)
    root.add_child(obj)

    expected = {
        "metadata.root": {
            "package": "acme::commerce",
            "children": [
                {"object.entity": {"name": "Product", "children": [
                    {"field.long": {"name": "id"}},
                    {"field.string": {"name": "name"}},
                    {"identity.primary": {"@fields": ["id"]}},
                ]}}
            ],
        }
    }
    assert json.loads(canonical_serialize(root)) == expected


def test_trailing_newline_and_indent() -> None:
    root = MetaRoot("metadata", "root", "")
    out = canonical_serialize(root)
    assert out.endswith("\n")
    assert "\n  " in canonical_serialize_nonempty_example()


def canonical_serialize_nonempty_example() -> str:
    root = MetaRoot("metadata", "root", "")
    root.package = "acme"
    return canonical_serialize(root)
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `uv run --extra dev pytest tests/unit/test_serializer.py -q`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Implement `serializer_json.py`**

```python
"""Canonical (fused-key) serializer. Deterministic per spec/conformance-tests.md."""
from __future__ import annotations

import json

from .meta.meta_data import MetaData
from .shared.separators import ATTR_PREFIX, FUSED_KEY_SEP
from .shared.structural import (
    KEY_ABSTRACT,
    KEY_CHILDREN,
    KEY_EXTENDS,
    KEY_IS_ARRAY,
    KEY_NAME,
    KEY_PACKAGE,
)


def canonical_serialize(node: MetaData) -> str:
    text = json.dumps(_to_canonical(node), indent=2, ensure_ascii=False)
    return text + "\n"


def _to_canonical(node: MetaData) -> dict[str, object]:
    return {f"{node.type}{FUSED_KEY_SEP}{node.sub_type}": _body(node)}


def _body(node: MetaData) -> dict[str, object]:
    body: dict[str, object] = {}
    if node.name:
        body[KEY_NAME] = node.name
    if node.package:
        body[KEY_PACKAGE] = node.package
    if node.super_ref:
        body[KEY_EXTENDS] = node.super_ref
    if node.is_abstract:
        body[KEY_ABSTRACT] = True
    if node.is_array:
        body[KEY_IS_ARRAY] = True

    for attr in sorted(node.own_meta_attrs(), key=lambda a: a.name):
        body[f"{ATTR_PREFIX}{attr.name}"] = _normalize(getattr(attr, "value", None))

    children = node.children()
    if children:
        body[KEY_CHILDREN] = [_to_canonical(c) for c in children]
    return body


def _normalize(value: object) -> object:
    """Mirror JSON.stringify: a whole-number float serializes as an int."""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, list):
        return [_normalize(v) for v in value]
    return value
```

- [ ] **Step 4: Run the tests**

Run: `uv run --extra dev pytest tests/unit/test_serializer.py -q`
Expected: `4 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/metaobjects/serializer_json.py tests/unit/test_serializer.py
git commit -m "feat(python): canonical fused-key JSON serializer"
```

---

### Task 10: Parser (JSON → node tree, attrs materialized, @fields desugared)

**Files:**
- Create: `server/python/src/metaobjects/parser.py`
- Test: `server/python/tests/unit/test_parser.py`

Phase-1 parser scope: parse one JSON document into a tree. Split each one-key node wrapper into `(type, sub_type)`; build the node via the registry factory; set `name`/`package`/`extends`/`abstract`/`isArray` from reserved keys; materialize each `@`-attr as an instance (subtype from the owner's attr schema, else inferred); recurse `children`. Unknown type/subtype → a `MetaError` (collected, non-strict). Super-resolution, overlay merge, and validation are later phases.

**Package handling (important):** `package` is set on a node **only when explicitly present in that node's body**. The canonical serializer omits inferred values (`spec/conformance-tests.md`: "If the parser would infer a value, and the input omits it, the canonical output ALSO omits it") — the corpus `object.entity` body carries no `package` even though the root declares one. Effective-package-for-FQN (walking up parents) is computed in Phase 2 when super-resolution needs it; Phase 1 must not propagate the root's package onto children.

- [ ] **Step 1: Write the failing test**

`tests/unit/test_parser.py`:
```python
from metaobjects.core_types import core_provider
from metaobjects.parser import parse_document
from metaobjects.provider import compose_registry

REG = compose_registry([core_provider])


def test_parses_empty_root() -> None:
    result = parse_document({"metadata.root": {}}, REG, source="x")
    assert not result.errors
    assert result.root.type == "metadata" and result.root.sub_type == "root"
    assert result.root.children() == []


def test_parses_entity_with_fields_and_desugars_identity_fields() -> None:
    doc = {
        "metadata.root": {
            "package": "acme::commerce",
            "children": [
                {"object.entity": {"name": "Product", "children": [
                    {"field.long": {"name": "id"}},
                    {"field.string": {"name": "name"}},
                    {"identity.primary": {"@fields": "id"}},
                ]}}
            ],
        }
    }
    result = parse_document(doc, REG, source="x")
    assert not result.errors
    root = result.root
    assert root.package == "acme::commerce"
    obj = root.children()[0]
    assert obj.name == "Product"
    ident = obj.children()[2]
    assert ident.attr("fields") == ["id"]  # desugared scalar -> array


def test_unknown_type_records_error() -> None:
    result = parse_document({"bogus.thing": {}}, REG, source="x")
    codes = [e.code.name for e in result.errors]
    assert "ERR_UNKNOWN_TYPE" in codes
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `uv run --extra dev pytest tests/unit/test_parser.py -q`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Implement `parser.py`**

```python
"""JSON document -> node tree. Owns inline-vs-child attr syntax (ADR-0002)."""
from __future__ import annotations

from dataclasses import dataclass, field

from .errors import ErrorCode, MetaError
from .meta.meta_data import MetaData
from .meta.meta_root import MetaRoot
from .registry import TypeRegistry
from .shared.base_types import SUBTYPE_ROOT, TYPE_METADATA
from .shared.separators import ATTR_PREFIX, FUSED_KEY_SEP
from .shared.structural import (
    KEY_ABSTRACT,
    KEY_CHILDREN,
    KEY_EXTENDS,
    KEY_IS_ARRAY,
    KEY_NAME,
    KEY_PACKAGE,
)

_RESERVED = {KEY_NAME, KEY_PACKAGE, KEY_EXTENDS, KEY_ABSTRACT, KEY_IS_ARRAY, KEY_CHILDREN}


@dataclass
class ParseResult:
    root: MetaData
    errors: list[MetaError] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def parse_document(doc: object, registry: TypeRegistry, source: str) -> ParseResult:
    result = ParseResult(root=MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, ""))
    if not isinstance(doc, dict):
        result.errors.append(MetaError("top-level is not an object", ErrorCode.ERR_TOP_LEVEL_NOT_OBJECT, source))
        return result
    if len(doc) != 1:
        result.errors.append(MetaError("expected one wrapper key", ErrorCode.ERR_TOP_LEVEL_NOT_OBJECT, source))
        return result

    (wrapper, body), = doc.items()
    node = _build(wrapper, body, registry, source, result)
    if isinstance(node, MetaData):
        result.root = node
    return result


def _build(
    wrapper: str,
    body: object,
    registry: TypeRegistry,
    source: str,
    result: ParseResult,
) -> MetaData | None:
    type_, _, sub_type = wrapper.partition(FUSED_KEY_SEP)
    if not sub_type:
        result.errors.append(MetaError(f"node '{wrapper}' omits subType", ErrorCode.ERR_MISSING_SUBTYPE, source))
        return None
    if not registry.has_type(type_):
        result.errors.append(MetaError(f"unknown type '{type_}'", ErrorCode.ERR_UNKNOWN_TYPE, source))
        return None
    definition = registry.find(type_, sub_type)
    if definition is None:
        result.errors.append(MetaError(f"unknown subType '{type_}.{sub_type}'", ErrorCode.ERR_UNKNOWN_SUBTYPE, source))
        return None

    body = body if isinstance(body, dict) else {}
    name = str(body.get(KEY_NAME, "") or "")
    node = definition.factory(type_, sub_type, name)
    assert isinstance(node, MetaData)

    pkg = body.get(KEY_PACKAGE)
    node.package = str(pkg) if pkg else None  # explicit only; inferred package is omitted (Phase 2 computes effective)
    if body.get(KEY_EXTENDS):
        node.super_ref = str(body[KEY_EXTENDS])
    node.is_abstract = bool(body.get(KEY_ABSTRACT, False))
    node.is_array = bool(body.get(KEY_IS_ARRAY, False))

    for key, value in body.items():
        if key.startswith(ATTR_PREFIX):
            attr_name = key[len(ATTR_PREFIX):]
            schema = registry.attr_schema(type_, sub_type, attr_name)
            node.set_attr(attr_name, value, sub_type=schema.value_type if schema else None)

    for cw, cbody in _iter_children(body):
        child = _build(cw, cbody, registry, source, result)
        if child is not None:
            node.add_child(child)

    return node


def _iter_children(body: dict[str, object]) -> list[tuple[str, object]]:
    raw = body.get(KEY_CHILDREN, [])
    out: list[tuple[str, object]] = []
    if isinstance(raw, list):
        for entry in raw:
            if isinstance(entry, dict) and len(entry) == 1:
                (cw, cbody), = entry.items()
                out.append((cw, cbody))
    return out
```

- [ ] **Step 4: Run the tests**

Run: `uv run --extra dev pytest tests/unit/test_parser.py -q`
Expected: `3 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/metaobjects/parser.py tests/unit/test_parser.py
git commit -m "feat(python): JSON parser (node tree, materialized attrs, @fields desugar)"
```

---

### Task 11: Loader (filesystem discovery + minimal pipeline)

**Files:**
- Create: `server/python/src/metaobjects/loader/__init__.py`
- Create: `server/python/src/metaobjects/loader/meta_data_loader.py`
- Test: `server/python/tests/unit/test_loader.py`

Phase-1 pipeline: discover `*.json` in a directory (ordinal-sorted), parse the **first** file (single-file fixtures only this phase), freeze, return `LoadResult(root, errors, warnings)`. Multi-file overlay merge is a later phase; for now, if more than one file is present, parse each and keep the last non-error root (sufficient for Phase-1 single-file fixtures; a later phase replaces this with real merge).

- [ ] **Step 1: Write the failing test**

`tests/unit/test_loader.py`:
```python
import json
from pathlib import Path

from metaobjects.loader.meta_data_loader import load_directory
from metaobjects.serializer_json import canonical_serialize


def test_load_single_entity_dir(tmp_path: Path) -> None:
    (tmp_path / "meta.commerce.json").write_text(json.dumps({
        "metadata.root": {"package": "acme", "children": [
            {"object.entity": {"name": "P", "children": [
                {"field.long": {"name": "id"}},
                {"identity.primary": {"@fields": "id"}},
            ]}}
        ]}
    }))
    result = load_directory(str(tmp_path))
    assert not result.errors
    assert result.root.frozen
    out = json.loads(canonical_serialize(result.root))
    assert out["metadata.root"]["children"][0]["object.entity"]["children"][1] == {
        "identity.primary": {"@fields": ["id"]}
    }
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `uv run --extra dev pytest tests/unit/test_loader.py -q`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Implement `loader/meta_data_loader.py`**

```python
"""Filesystem loader: discover -> parse -> freeze. (Merge/super/validation: later phases.)"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from ..core_types import core_provider
from ..errors import ErrorCode, MetaError
from ..meta.meta_data import MetaData
from ..meta.meta_root import MetaRoot
from ..parser import parse_document
from ..provider import Provider, compose_registry
from ..shared.base_types import SUBTYPE_ROOT, TYPE_METADATA


@dataclass
class LoadResult:
    root: MetaData
    errors: list[MetaError] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def load_directory(input_dir: str, providers: list[Provider] | None = None) -> LoadResult:
    registry = compose_registry(providers if providers is not None else [core_provider])
    result = LoadResult(root=MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, ""))

    files = sorted(Path(input_dir).glob("*.json"), key=lambda p: p.name)
    for path in files:
        try:
            doc = json.loads(path.read_text())
        except json.JSONDecodeError as exc:
            result.errors.append(MetaError(str(exc), ErrorCode.ERR_MALFORMED_JSON, path.name))
            continue
        parsed = parse_document(doc, registry, source=path.name)
        result.errors.extend(parsed.errors)
        result.warnings.extend(parsed.warnings)
        if not parsed.errors:
            result.root = parsed.root  # Phase-1: last good root wins (single-file fixtures)

    result.root.freeze()
    return result
```

Create empty `loader/__init__.py`.

- [ ] **Step 4: Run the tests**

Run: `uv run --extra dev pytest tests/unit/test_loader.py -q`
Expected: `1 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/metaobjects/loader/ tests/unit/test_loader.py
git commit -m "feat(python): filesystem loader (discover, parse, freeze)"
```

---

### Task 12: Conformance harness + expected-failures ledger (CI green from commit #1)

**Files:**
- Create: `server/python/tests/conformance/__init__.py`
- Create: `server/python/tests/conformance/corpus.py`
- Create: `server/python/tests/conformance/fixture_discovery.py`
- Create: `server/python/tests/conformance/expected_failures.py`
- Create: `server/python/tests/conformance/conformance_adapter.py`
- Create: `server/python/tests/conformance/test_conformance.py`
- Create: `server/python/tests/conformance/conformance-expected-failures.json`

The ledger initially lists **all** fixtures, so the suite is green even though the loader only handles a few. Subsequent slices remove names as they pass.

- [ ] **Step 1: Write `corpus.py` (locate the corpus by walking up — no absolute paths)**

```python
"""Locate the shared conformance corpus relative to this file (repo public; no hardcoded paths)."""
from __future__ import annotations

from pathlib import Path


def corpus_root() -> Path:
    here = Path(__file__).resolve()
    for parent in [here, *here.parents]:
        candidate = parent / "fixtures" / "conformance"
        if candidate.is_dir():
            return candidate
    raise RuntimeError("could not locate fixtures/conformance from " + str(here))
```

- [ ] **Step 2: Write `fixture_discovery.py`**

```python
"""Discover conformance scenario directories, sorted by name, with expectation-file flags."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Fixture:
    name: str
    dir: Path
    input_dir: Path
    has_expected: bool
    has_expected_errors: bool
    has_expected_warnings: bool
    has_script: bool


def discover_fixtures(corpus: Path) -> list[Fixture]:
    fixtures: list[Fixture] = []
    for entry in sorted(p for p in corpus.iterdir() if p.is_dir()):
        input_dir = entry / "input"
        if not input_dir.is_dir():
            continue  # CAPABILITIES.json etc. are files, not fixtures
        fixtures.append(
            Fixture(
                name=entry.name,
                dir=entry,
                input_dir=input_dir,
                has_expected=(entry / "expected.json").is_file(),
                has_expected_errors=(entry / "expected-errors.json").is_file(),
                has_expected_warnings=(entry / "expected-warnings.json").is_file(),
                has_script=(entry / "script.json").is_file(),
            )
        )
    return fixtures
```

- [ ] **Step 3: Write `expected_failures.py`**

```python
"""Expected-failures ledger classifier (porting guide §6)."""
from __future__ import annotations

import json
from pathlib import Path

_LEDGER_PATH = Path(__file__).with_name("conformance-expected-failures.json")


def _ledger() -> set[str]:
    if not _LEDGER_PATH.is_file():
        return set()
    return set(json.loads(_LEDGER_PATH.read_text()).get("fixtures", []))


def classify(passed: bool, name: str) -> str:
    listed = name in _ledger()
    if not passed:
        return "known-gap" if listed else "fail"
    return "fixed-but-listed" if listed else "pass"
```

- [ ] **Step 4: Write `conformance_adapter.py`**

```python
"""Bridge the corpus to the Python loader."""
from __future__ import annotations

from pathlib import Path

from metaobjects.core_types import core_provider
from metaobjects.loader.meta_data_loader import load_directory
from metaobjects.serializer_json import canonical_serialize


def load_fixture(input_dir: Path) -> tuple[list[str], list[str], str]:
    """Return (error_codes, warnings, canonical_serialization)."""
    result = load_directory(str(input_dir), providers=[core_provider])
    codes = [e.code.name for e in result.errors]
    canonical = canonical_serialize(result.root)
    return codes, list(result.warnings), canonical
```

- [ ] **Step 5: Write `test_conformance.py`** (parametrized; mirrors the TS/C# runner check ordering)

```python
"""Conformance runner — one parametrized test per fixture (porting guide §6)."""
from __future__ import annotations

import json

import pytest

from .conformance_adapter import load_fixture
from .corpus import corpus_root
from .expected_failures import classify
from .fixture_discovery import Fixture, discover_fixtures

_FIXTURES = discover_fixtures(corpus_root())


def _run_checks(fix: Fixture) -> tuple[bool, str]:
    codes, warnings, canonical = load_fixture(fix.input_dir)
    failures: list[str] = []

    if fix.has_expected_errors:
        want = sorted(json.loads((fix.dir / "expected-errors.json").read_text()))
        got = sorted(codes)
        if want != got:
            failures.append(f"errors: want {want} got {got}")

    tree_blocked = bool(codes) and not fix.has_expected_errors and fix.has_expected
    if tree_blocked:
        failures.append(f"load produced errors {codes}; cannot run tree checks")

    if fix.has_expected and not tree_blocked:
        want_tree = json.loads((fix.dir / "expected.json").read_text())
        got_tree = json.loads(canonical)
        if want_tree != got_tree:
            failures.append("canonical serialization mismatch")

    if fix.has_expected_warnings:
        want_w = sorted(json.loads((fix.dir / "expected-warnings.json").read_text()))
        if want_w != sorted(warnings):
            failures.append(f"warnings: want {want_w} got {sorted(warnings)}")
    elif fix.has_expected and not tree_blocked and warnings:
        failures.append(f"unexpected warnings: {warnings}")

    return (not failures), "; ".join(failures)


@pytest.mark.parametrize("fix", _FIXTURES, ids=[f.name for f in _FIXTURES])
def test_conformance(fix: Fixture) -> None:
    passed, detail = _run_checks(fix)
    status = classify(passed, fix.name)
    assert status in ("pass", "known-gap"), f"{fix.name} [{status}]: {detail}"
```

- [ ] **Step 6: Write the ledger seeded with ALL fixtures**

Generate it from the corpus so every fixture starts as a known-gap:

Run (from `server/python`):
```bash
uv run python - <<'PY'
import json, pathlib
from tests.conformance.corpus import corpus_root
names = sorted(p.name for p in corpus_root().iterdir() if (p / "input").is_dir())
out = pathlib.Path("tests/conformance/conformance-expected-failures.json")
out.write_text(json.dumps({"fixtures": names}, indent=2) + "\n")
print(f"seeded {len(names)} fixtures")
PY
```
Expected: `seeded 55 fixtures`.

- [ ] **Step 7: Run the conformance suite**

Run: `uv run --extra dev pytest tests/conformance -q`
Expected: all parametrized cases pass (every fixture is `known-gap` or `pass`); summary like `55 passed`.

- [ ] **Step 8: Run the full suite + mypy**

Run: `uv run --extra dev pytest -q && uv run --extra dev mypy`
Expected: all green; mypy clean.

- [ ] **Step 9: Commit**

```bash
git add tests/conformance/
git commit -m "feat(python): conformance harness + expected-failures ledger (CI green, all known-gap)"
```

---

### Task 13: Turn the four basic fixtures green

**Files:**
- Modify: `server/python/tests/conformance/conformance-expected-failures.json`

The loader already produces correct canonical output for the simplest fixtures; removing them from the ledger flips them from `known-gap` to `pass` (and a regression would now turn the suite red).

- [ ] **Step 1: Confirm the four fixtures actually pass before delisting**

Run:
```bash
uv run --extra dev pytest tests/conformance -q \
  -k "smoke_empty_metadata or loader_basic_single_entity or loader_basic_explicit_subtype or loader_basic_empty_package"
```
Note: pytest converts `-` to `_` in ids; if `-k` matching is finicky, run the whole file and read the per-id results. Each of the four must currently be classified `known-gap` (i.e., it passes the checks but is still listed). To verify they pass the *checks*, temporarily remove them in the next step and re-run.

- [ ] **Step 2: Remove the four names from the ledger**

Edit `tests/conformance/conformance-expected-failures.json` and delete these four entries:
```
"smoke-empty-metadata",
"loader-basic-single-entity",
"loader-basic-explicit-subtype",
"loader-basic-empty-package",
```

- [ ] **Step 3: Run the conformance suite**

Run: `uv run --extra dev pytest tests/conformance -q`
Expected: still all green. The four are now `pass` (unlisted+pass); the rest remain `known-gap`. If any of the four now reports `fail`, the loader output diverges from `expected.json` — debug the serializer/parser against that fixture (it is the oracle), do **not** re-add it to the ledger to hide the failure.

- [ ] **Step 4: Run the full suite + mypy**

Run: `uv run --extra dev pytest -q && uv run --extra dev mypy`
Expected: all green; mypy clean.

- [ ] **Step 5: Commit**

```bash
git add tests/conformance/conformance-expected-failures.json
git commit -m "test(python): first four loader-basic fixtures green (delisted from ledger)"
```

---

## Phase 1 — Definition of done

- `uv run --extra dev pytest -q` green; `uv run --extra dev mypy` clean.
- The conformance suite runs over all 55 corpus fixtures; the four `loader-basic`/`smoke` fixtures **pass**, the rest are honestly **known-gap** in the ledger.
- The extensibility seam is in place and exercised: a subtype is a class + a registration entry; constants are colocated; `compose_registry` topo-sorts providers.
- No absolute/home paths committed; public-repo hygiene clean.

## Self-review notes (author)

- **Spec coverage:** Phase 1 implements design §"Package layout", §"Extensibility model" (registry/provider/colocated constants/behavior-on-class), §"Loader pipeline" (discovery→parse→freeze; merge/super/validation explicitly deferred), §"Conformance harness" (runner + ledger). Deferred-to-Phase-2/3 (called out in the design's slice plan): overlay merge, super-resolution, the six validation passes, sources/origins/relationships, the `script.json` fixture, the Open-Closed proof test.
- **Type consistency:** `set_attr(name, value, sub_type=...)`, `attr(name)`, `own_meta_attrs()`, `effective_children()`, `canonical_serialize(node)`, `parse_document(doc, registry, source)`, `load_directory(input_dir, providers=...)`, `compose_registry([...])`, `classify(passed, name)` are used consistently across tasks.
- **Known Phase-1 simplification:** `load_directory` keeps the last good root for multi-file dirs instead of merging; this is sufficient for the single-file Phase-1 fixtures and is replaced by real overlay merge in Phase 2 (multi-file fixtures stay `known-gap` until then).
