"""Shared helpers for the docs view tests: load a ``fixtures/explorer-conformance`` case."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from metaobjects import MetaDataLoader
from metaobjects.core_types import core_providers
from metaobjects.meta.meta_data import MetaData
from metaobjects.provider import Provider
from metaobjects.registry import AttrSchema, ChildRule, TypeDefinition, TypeRegistry


def corpus() -> Path:
    for parent in Path(__file__).resolve().parents:
        c = parent / "fixtures" / "explorer-conformance"
        if c.is_dir():
            return c
    raise RuntimeError("fixtures/explorer-conformance not found")


def fixtures() -> list[str]:
    return sorted(p.name for p in corpus().iterdir() if p.is_dir())


def read_json(case: Path, name: str) -> Any:
    p = case / name
    return json.loads(p.read_text(encoding="utf-8")) if p.is_file() else None


def _slots(children: list[dict[str, Any]]) -> tuple[list[AttrSchema], list[ChildRule]]:
    attrs: list[AttrSchema] = []
    rules: list[ChildRule] = []
    for slot in children:
        if slot["type"] == "attr":
            attrs.append(AttrSchema(
                name=slot["name"], value_type="string", required=slot.get("min", 0) > 0,
                is_array=bool(slot.get("isArray")), description=slot.get("description", "an attribute"),
            ))
        else:
            rules.append(ChildRule(child_type=slot["type"], child_sub_type=slot["subType"], child_name=slot["name"]))
    return attrs, rules


def fixture_provider(definition: dict[str, Any]) -> Provider:
    """A provider for a fixture's provider.json: every type a plain node."""
    p = Provider(definition["provider"], ("metaobjects-core-types",))
    for t in definition["types"]:
        attrs, rules = _slots(t["children"])
        p.add(TypeDefinition(
            type=t["type"], sub_type=t["subType"], factory=lambda ty, st, n: MetaData(ty, st, n),
            attrs=attrs, child_rules=rules, description=t.get("description", "a node"),
        ))

    def extend(registry: TypeRegistry) -> None:
        for e in definition["extends"]:
            _, rules = _slots(e["children"])
            registry.extend(e["type"], e["subType"], child_rules=rules)

    p.on_register(extend)
    return p


def load_case(name: str) -> MetaData:
    """The case's project, loaded strictly with its provider.json applied."""
    case = corpus() / name
    definition = read_json(case, "provider.json")
    providers = list(core_providers)
    if definition is not None:
        providers.append(fixture_provider(definition))
    result = MetaDataLoader.from_directory(case / "project" / "metaobjects", providers=providers, strict=True, discover_naming=False)
    assert not result.errors, f"{name}: expected a clean strict load, got {result.errors}"
    return result.root
