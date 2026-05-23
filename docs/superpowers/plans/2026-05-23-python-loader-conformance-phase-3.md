# Python Loader + Conformance — Phase 3 (merge + super-resolution + script.json) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Complete the loader pipeline structurally — multi-file/overlay **merge**, deferred **super-resolution**, and the **script.json** capability check — turning 7 more corpus fixtures green (`loader-basic-multi-file-same-package`, `overlay-attr-last-writer-wins`, `overlay-merge-flag-explicit`, `overlay-same-object-different-files`, `extends-cross-file`, `error-extends-nonexistent`, `extends-abstract-base`). After Phase 3 only the validation passes (Phase 4) + `prompt.*` (FR-004) remain.

**Architecture:** Keep the parser pure (parse each file into its own root, unchanged from Phase 1/2). Add a **post-parse merge** step in the loader that folds all roots into one, then a **deferred super-resolution** pass over the merged root, then freeze. This is idiomatic Python (Tier-3 mechanism) and matches the *observable* TS/C# behavior (the corpus is the oracle). Behavior contracts below come from the reference (`server/typescript/packages/metadata/src/loader/meta-data-loader.ts`, `parser-core.ts`, `super-resolve.ts`) and the porting guide §3/§5.

**Tech/process:** Python 3.11+, uv, pytest, mypy (now also checks `tests/`). Worktree `feat/python-loader-phase-3`. Run from `server/python`. **Conformance corpus is the oracle.** **Ledger discipline:** each task implements, runs `uv run --extra dev pytest tests/conformance -q`, and **delists every now-passing fixture** from `tests/conformance/conformance-expected-failures.json` in the SAME commit; keep the whole suite green at every commit; never delist a still-failing fixture. Mypy strict over src+tests must stay clean. Public repo — no home paths / private names. Commit guard: never `--no-verify`.

**Patterns to copy:** Phase 1/2 node + registration style; the existing `meta/meta_data.py` (`super_ref`, `super_data`, `effective_children()`, `fqn()`), `loader/meta_data_loader.py` (current discover→parse→"last good root wins"→freeze), `errors.py` (`ErrorCode`, `MetaError`), and the conformance runner `tests/conformance/test_conformance.py` (which currently treats `has_script` as a forced gap — P3.4 replaces that with real execution).

---

### Task P3.1: Effective package + FQN index

**Files:** modify `src/metaobjects/meta/meta_data.py`; test `tests/unit/test_effective_package.py`.

`package` stays explicit-only (canonical must keep omitting inferred package — do NOT change the serializer or parser package handling). Add a derived accessor for FQN/resolution that walks ancestors:

- [ ] **Step 1 — failing test** `tests/unit/test_effective_package.py`:
```python
from metaobjects.meta.meta_data import MetaData


class _N(MetaData):
    pass


def test_effective_package_walks_to_nearest_ancestor() -> None:
    root = _N("metadata", "root", "")
    root.package = "acme::commerce"
    obj = _N("object", "entity", "Product")          # no explicit package
    root.add_child(obj)
    fld = _N("field", "long", "id")
    obj.add_child(fld)
    assert obj.effective_package() == "acme::commerce"   # inherited from root
    assert obj.effective_fqn() == "acme::commerce::Product"
    # explicit package on the node wins
    obj.package = "acme::other"
    assert obj.effective_package() == "acme::other"
```

- [ ] **Step 2** run it → fails (no `effective_package`). `uv run --extra dev pytest tests/unit/test_effective_package.py -q`.

- [ ] **Step 3 — implement** on `MetaData`:
```python
def effective_package(self) -> str | None:
    node: MetaData | None = self
    while node is not None:
        if node.package:
            return node.package
        node = node.parent
    return None

def effective_fqn(self) -> str:
    pkg = self.effective_package()
    return self.name if not pkg else f"{pkg}{PACKAGE_SEP}{self.name}"
```
(`PACKAGE_SEP` already imported in `meta_data.py`.) Do NOT change `fqn()` (it stays package-of-this-node only, used in error messages) — `effective_fqn()` is the resolution/index key.

- [ ] **Step 4** run test → pass; full suite + mypy green.
- [ ] **Step 5** commit: `feat(python): effective_package/effective_fqn (ancestor-walk for FQN resolution)`.

---

### Task P3.2: Multi-file / overlay merge

**Files:** create `src/metaobjects/loader/merge.py`; modify `src/metaobjects/loader/meta_data_loader.py`; test `tests/unit/test_merge.py`. Reference `errors.py` for `ERR_OVERLAY_NO_TARGET`.

**Contract (from the reference + fixtures):** Merge a list of parsed roots into the first root. Merging source node S into target node T:
- For each child `sc` of S: find a child `tc` of T with the same `(type, name)`.
  - If found → **merge** recursively: `sc`'s own attrs overwrite `tc`'s (last-writer-wins), then merge `sc`'s children into `tc`.
  - If not found → **append** `sc` to T (reparent: `sc.parent = T`).
- The `overlay` flag (a node body key `overlay: true`, parsed onto the node — see note) only matters when a node declares it and NO matching target exists at that level → `ERR_OVERLAY_NO_TARGET`. (No Phase-3 fixture triggers this; implement it for completeness, gated so the common silent-merge path is unaffected.)
- Matching uses `(type, name)` only (not subType, not package — same-package is implied by the corpus; a multi-package merge isn't exercised). Order: existing children keep position; appended children go to the end.

**Note on the `overlay` flag:** the parser currently reads `abstract`/`isArray` but the `overlay` body key (`KEY_OVERLAY`, already in `shared/structural.py`) is not stored. Add an `is_overlay: bool` field to `MetaData` (default False) and have the parser set it from `KEY_OVERLAY` (mirror how it sets `is_abstract`). Do NOT serialize it (the canonical serializer must not emit `overlay` — confirm the corpus `expected.json` for overlay fixtures shows no `overlay` key; if a fixture DOES show it, match that, but per ADR/serializer rules it's authoring-only and omitted).

- [ ] **Step 1 — failing test** `tests/unit/test_merge.py` covering: (a) two roots, different object names → root has both children appended in order; (b) two roots, same object name → objects merged, children accumulated, second root's conflicting attr wins. Build the roots with `MetaData`/`MetaObject` directly + `set_attr`, call `merge_roots([...])`, assert the merged tree's children/attrs. (Import `metaobjects.core_types` so attr classes are registered for `set_attr`.)

- [ ] **Step 2** run → fails.

- [ ] **Step 3 — implement `merge.py`:**
```python
"""Multi-file / overlay merge: fold parsed roots into one (post-parse, pre-super-resolve)."""
from __future__ import annotations

from ..errors import ErrorCode, MetaError
from ..meta.meta_data import MetaData


def merge_roots(roots: list[MetaData], errors: list[MetaError]) -> MetaData:
    """Merge all roots into the first. Returns the merged root (or a fresh one if empty)."""
    if not roots:
        raise ValueError("merge_roots requires at least one root")
    target = roots[0]
    for src in roots[1:]:
        _merge_into(target, src, errors)
    return target


def _merge_into(target: MetaData, src: MetaData, errors: list[MetaError]) -> None:
    # attrs: source overwrites target (last-writer-wins)
    for attr in src.own_meta_attrs():
        target.set_attr(attr.name, getattr(attr, "value", None), sub_type=attr.sub_type)
    # children: merge by (type, name), else append
    for sc in src.children():
        tc = next((c for c in target.children()
                   if c.type == sc.type and c.name == sc.name), None)
        if tc is not None:
            _merge_into(tc, sc, errors)
        else:
            if getattr(sc, "is_overlay", False):
                errors.append(MetaError(
                    f"overlay node '{sc.effective_fqn()}' has no merge target",
                    ErrorCode.ERR_OVERLAY_NO_TARGET, path=sc.effective_fqn()))
            sc.parent = target
            target.add_child(sc)
```
(Note: `set_attr` on a not-yet-frozen node is fine; merge runs before freeze. `own_meta_attrs()`/`children()`/`add_child` already exist.)

- [ ] **Step 4 — wire into the loader.** In `meta_data_loader.py`, replace the "last good root wins" loop: parse every `*.json` into its own root (collect roots from successful parses), accumulate parse errors/warnings, then `merged = merge_roots(roots, result.errors)` (if any roots), set `result.root = merged`, then freeze. (Keep malformed-JSON → `ERR_MALFORMED_JSON` + skip behavior.)

- [ ] **Step 5** run conformance. Delist now-passing: `loader-basic-multi-file-same-package`, `overlay-attr-last-writer-wins`, `overlay-merge-flag-explicit`, `overlay-same-object-different-files`, `extends-cross-file` (the last greens from merge alone — its canonical output keeps `extends` as a raw ref; super-resolution is not needed for canonical). Confirm each actually passes before delisting. Full suite + mypy green.
- [ ] **Step 6** commit: `feat(python): multi-file/overlay merge (merge_roots; last-writer attrs, children accumulate)`.

---

### Task P3.3: Deferred super-resolution

**Files:** create `src/metaobjects/super_resolve.py`; modify `src/metaobjects/loader/meta_data_loader.py`; test `tests/unit/test_super_resolve.py`.

**Contract:** After merge, before freeze, walk the merged tree; for each node with a `super_ref`, resolve it against the tree's effective-FQN index and set `super_data`. Unresolved → `ERR_UNRESOLVED_SUPER`. Resolution forms (context = the node's `effective_package()`):
- **absolute** `"::pkg::Name"` → strip leading `::`, look up FQN `pkg::Name`.
- **relative** `"..::rest"` → drop one trailing package segment from context per leading `..::`, then resolve `rest` against the reduced context (try `reducedCtx::rest` then root-rooted `rest`).
- **bare/qualified** `"Name"` or `"pkg::Name"` (no leading `::`/`..`) → try `context::ref` first, then root-rooted `ref`.

Build an index `effective_fqn -> node` over ALL nodes in the merged tree (walk children recursively). Canonical output must be UNCHANGED (super_data is internal; the serializer already emits only `super_ref` as `extends`). Resolution is idempotent; skip nodes already resolved.

- [ ] **Step 1 — failing test** `tests/unit/test_super_resolve.py`: build a root (pkg `acme`) with `Base` and `Sub` (Sub.super_ref="Base"); call `resolve_supers(root, errors)`; assert `Sub.super_data is Base` and `errors == []`. Second case: `Sub.super_ref="Nope"` → `errors` has one `ERR_UNRESOLVED_SUPER` and `Sub.super_data is None`. Third: `Sub.effective_children()` after resolution includes Base's children (super-chain).

- [ ] **Step 2** run → fails.

- [ ] **Step 3 — implement `super_resolve.py`:**
```python
"""Deferred super/extends resolution over the merged tree (2nd pass, pre-freeze)."""
from __future__ import annotations

from .errors import ErrorCode, MetaError
from .meta.meta_data import MetaData
from .shared.separators import PACKAGE_SEP


def resolve_supers(root: MetaData, errors: list[MetaError]) -> None:
    index = _build_index(root)
    for node in _walk(root):
        if node.super_ref and node.super_data is None:
            target = _resolve(node.super_ref, node.effective_package(), index)
            if target is None:
                errors.append(MetaError(
                    f"the SuperClass '{node.super_ref}' does not exist "
                    f"(referenced by {node.effective_fqn()})",
                    ErrorCode.ERR_UNRESOLVED_SUPER, path=node.effective_fqn()))
            else:
                node.super_data = target


def _walk(node: MetaData) -> list[MetaData]:
    out = [node]
    for c in node.children():
        out.extend(_walk(c))
    return out


def _build_index(root: MetaData) -> dict[str, MetaData]:
    idx: dict[str, MetaData] = {}
    for node in _walk(root):
        if node.name:
            idx.setdefault(node.effective_fqn(), node)
    return idx


def _resolve(ref: str, context_pkg: str | None, index: dict[str, MetaData]) -> MetaData | None:
    if ref.startswith(PACKAGE_SEP):                       # absolute ::pkg::Name
        return index.get(ref[len(PACKAGE_SEP):])
    if ref.startswith(".." + PACKAGE_SEP):                # relative ..::rest
        segs = (context_pkg or "").split(PACKAGE_SEP) if context_pkg else []
        rest = ref
        while rest.startswith(".." + PACKAGE_SEP):
            rest = rest[len(".." + PACKAGE_SEP):]
            segs = segs[:-1]
        reduced = PACKAGE_SEP.join(segs)
        return index.get(f"{reduced}{PACKAGE_SEP}{rest}" if reduced else rest) or index.get(rest)
    # bare or pkg-qualified (no leading :: / ..)
    if context_pkg:
        hit = index.get(f"{context_pkg}{PACKAGE_SEP}{ref}")
        if hit is not None:
            return hit
    return index.get(ref)
```

- [ ] **Step 4 — wire into loader:** after `merge_roots(...)` and before `freeze()`, call `resolve_supers(result.root, result.errors)`.

- [ ] **Step 5** run conformance. Delist `error-extends-nonexistent` (now emits `ERR_UNRESOLVED_SUPER`). Confirm canonical-passing fixtures (extends-*, origin projections) STILL pass (resolution must not change canonical output). Full suite + mypy green.
- [ ] **Step 6** commit: `feat(python): deferred super-resolution (2nd pass; ERR_UNRESOLVED_SUPER)`.

---

### Task P3.4: script.json capability (navigate / invoke)

**Files:** create `src/metaobjects/meta/core/object/meta_object.py` accessors as needed (it already has `fields()`); create `tests/conformance/navigator.py` + `tests/conformance/capabilities.py`; modify `tests/conformance/test_conformance.py`. Read `fixtures/conformance/extends-abstract-base/script.json` for the exact operation shapes.

**Contract (from the fixture):** `script.json` = `{"operations": [{"navigate": [...], "invoke": "<cap>", "args"?: {...}, "expect": {...}}, ...]}`.
- **navigate**: a list of `"<type>:<name>"` segments from the root; resolve by walking children matching `node.type == type and node.name == name`. Returns the node or None (None → operation fails).
- **invoke** capabilities (return a normalized dict compared to `expect`):
  - `object.effective-fields` → `{"names": [f.name for f in node.fields()]}` (effective: own + inherited via super chain — `fields()` already uses `effective_children()`).
  - `object.own-fields` → `{"names": [own field names]}` (own children only; add `own_fields()` to `MetaObject` if missing: fields from `children()` not `effective_children()`).
  - `object.find-field` with `args={"name": X}` → the field as `{"name": X, ...}` if present, else `{"absent": true}`. Match `expect` exactly (read the fixture for the shape it asserts).
  - `object.primary-identity` → `{"subtype": "primary"}` or whatever the fixture's expect shows (read it).
- Compare `actual == expect` (dict deep-equal). Mismatch / unresolved navigate / unknown capability → the operation fails → the fixture fails.

**MetaObject accessors needed** (add to `meta_object.py`, mirroring `fields()`):
```python
def own_fields(self) -> list["MetaField"]:
    return [c for c in self.children() if isinstance(c, MetaField)]
def primary_identity(self):  # -> MetaIdentity | None
    from ..identity.meta_identity import MetaIdentity
    from ..identity.identity_constants import IDENTITY_SUBTYPE_PRIMARY
    return next((c for c in self.effective_children()
                 if isinstance(c, MetaIdentity) and c.sub_type == IDENTITY_SUBTYPE_PRIMARY), None)
def find_field(self, name: str):  # -> MetaField | None
    return next((f for f in self.fields() if f.name == name), None)
```
(Adjust to match the EXACT `expect` shapes in the fixture — the fixture is the oracle.)

**Runner change:** in `test_conformance.py` `_run_checks`, replace the `if fix.has_script: failures.append("script.json checks not implemented (Phase 2)")` block with: parse `script.json`, run each operation via a `navigate(root, path)` + `invoke(node, capability, args)` helper (in the new `navigator.py`/`capabilities.py`), append a failure per operation whose `actual != expect` (or that can't navigate/invoke). Keep all other checks unchanged.

- [ ] **Step 1** read `extends-abstract-base/script.json` + `expected.json`; write the navigator/capabilities + the `MetaObject` accessors to satisfy exactly those operations. (TDD: a unit test in `tests/unit/test_capabilities.py` building Base+Sub, resolving supers, asserting `effective-fields` names == inherited+own order is a good guard.)
- [ ] **Step 2** wire the runner to execute scripts.
- [ ] **Step 3** run conformance → `extends-abstract-base` should pass (its script's effective-fields needs P3.3 super-resolution, which the loader now runs). Delist it.
- [ ] **Step 4** full suite + mypy green; ledger has zero `fail`/`fixed-but-listed`.
- [ ] **Step 5** commit: `feat(python): execute script.json capability checks (navigate/invoke)`.

---

## Phase 3 — definition of done
- `uv run --extra dev pytest -q` green; `uv run --extra dev mypy` clean (src + tests).
- 7 fixtures delisted (merge ×5, super ×1, script ×1) → ledger ~21 → ~14 known-gaps (the 10 Phase-4 validation fixtures + 3 `prompt.*` + any origin/source still needing validation; verify the actual remaining set is exactly the validation + prompt buckets).
- Canonical output byte-identical for previously-green fixtures (merge/super must not change it). Open-Closed proof + registry-completeness tests still pass.

## Self-review note
Merge matches children by `(type, name)` only (sufficient for the corpus; subType/package matching isn't exercised). Super-resolution's effective-package uses a simple ancestor-walk (the field-level selective-inheritance nuances in the TS parser aren't exercised by Phase-3 object-extends fixtures). If a future fixture needs finer rules, refine then — the ledger keeps it honest. The `prompt.*` (3) and the 10 validation fixtures remain known-gaps for Phase 4 / FR-004.
