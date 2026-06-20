"""The recursive validation walk, DERIVED FROM THE TYPE REGISTRY.

Each node's TypeDefinition carries its reference descriptors + imperative validator, so a
downstream provider's type validates itself just by being registered. Per node: apply the
type's declared references (resolve against the symbol table), invoke its validator, recurse.
Mirrors the TS/Java/C# realization.
"""

from __future__ import annotations

from ..errors import ErrorCode, MetaError
from ..meta.core.object.meta_object import MetaObject
from ..meta.meta_data import MetaData
from ..meta.meta_root import MetaRoot
from ..registry import TypeRegistry
from ..shared.base_types import TYPE_OBJECT


class SymbolTable:
    """An index of every top-level object, built once per load (the binder analogue)."""

    def __init__(self) -> None:
        self._index: dict[str, MetaData] = {}

    @classmethod
    def build(cls, root: MetaData) -> "SymbolTable":
        t = cls()
        for child in root.own_children():
            if child.type == TYPE_OBJECT and isinstance(child, MetaObject):
                if child.name:
                    t._index[child.name] = child
                t._index[child.fqn()] = child
                t._index[child.resolution_key()] = child
        return t

    def resolve_object(self, reference: str) -> MetaData | None:
        return self._index.get(reference)


class ValidationContext:
    def __init__(self, symbols: SymbolTable) -> None:
        self.symbols = symbols
        self.errors: list[MetaError] = []

    def error(self, code: str, node: MetaData, message: str) -> None:
        # Core descriptors use built-in codes; a downstream provider's custom code (not in
        # the enum) maps to ERR_UNKNOWN for now (the message carries the detail).
        try:
            ec = ErrorCode(code)
        except ValueError:
            ec = ErrorCode.ERR_UNKNOWN
        self.errors.append(MetaError(message, ec, envelope=node.source))


def run(root: MetaRoot, registry: TypeRegistry) -> list[MetaError]:
    ctx = ValidationContext(SymbolTable.build(root))
    _walk(root, registry, ctx)
    return ctx.errors


def _walk(node: MetaData, registry: TypeRegistry, ctx: ValidationContext) -> None:
    type_def = registry.find(node.type, node.sub_type)
    if type_def is not None:
        for desc in type_def.references:
            raw = node.attr(desc.attr)
            if not isinstance(raw, str) or raw == "":
                continue  # absence is the required-attr pass's job
            entity_ref = raw.split(".", 1)[0] if desc.dotted_field_path else raw
            target = ctx.symbols.resolve_object(entity_ref)
            if target is None:
                ctx.error(
                    desc.error_code, node,
                    f'{node.type}.{node.sub_type} "{node.name}" @{desc.attr} "{raw}" '
                    f"does not resolve to an object.",
                )
            elif target.type != desc.target_type or (
                desc.target_sub_type is not None and target.sub_type != desc.target_sub_type
            ):
                want = (
                    f"{desc.target_type}.{desc.target_sub_type}"
                    if desc.target_sub_type
                    else desc.target_type
                )
                ctx.error(
                    desc.error_code, node,
                    f'{node.type}.{node.sub_type} "{node.name}" @{desc.attr} "{raw}" '
                    f"resolves to {target.type}.{target.sub_type}, not a {want}.",
                )
        if type_def.validate is not None:
            type_def.validate(node, ctx)
    for child in node.own_children():
        _walk(child, registry, ctx)
