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
from ..naming_refs import did_you_mean_hint
from ..registry import TypeRegistry
from ..shared.base_types import TYPE_OBJECT
from ..shared.separators import PACKAGE_SEP


class SymbolTable:
    """An index of every top-level object, built once per load (the binder analogue)."""

    def __init__(self) -> None:
        self._index: dict[str, MetaData] = {}

    @classmethod
    def build(cls, root: MetaData) -> "SymbolTable":
        t = cls()
        # ADR-0039 sanctioned own: top-level object scan on the loader ROOT (never
        # extended, own == effective) — mirrors the TS validation-registry.
        for child in root.own_children():
            if child.type == TYPE_OBJECT and isinstance(child, MetaObject):
                # ADR-0042: key by the canonical resolution key ONLY (the FQN, or
                # the bare name for a root-level/empty-package object) — NO bare-name
                # fallback, so a bare ref never binds a same-named object in another
                # package. Mirrors the TS validation-registry symbol table.
                t._index[child.resolution_key()] = child
        return t

    def resolve_object(self, reference: str, referrer_pkg: str) -> MetaData | None:
        """ADR-0042 package-local resolution: FQN → exact resolution-key match;
        bare → the referrer's own package (``<referrer_pkg>::<ref>``), else a
        root-level object. Mirrors the TS ``resolveObject``."""
        if PACKAGE_SEP in reference:
            return self._index.get(reference)
        local_key = (
            f"{referrer_pkg}{PACKAGE_SEP}{reference}" if referrer_pkg else reference
        )
        return self._index.get(local_key) or self._index.get(reference)


class ValidationContext:
    def __init__(self, symbols: SymbolTable, root: MetaData) -> None:
        self.symbols = symbols
        self.root = root
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
    ctx = ValidationContext(SymbolTable.build(root), root)
    _walk(root, registry, ctx, "")
    return ctx.errors


def _walk(
    node: MetaData, registry: TypeRegistry, ctx: ValidationContext, referrer_pkg: str
) -> None:
    # ADR-0042: a top-level object establishes the package context for its subtree;
    # nested ref-bearing nodes (relationship/field.object/identity.reference) resolve
    # BARE refs against it. Nested nodes carry no `package`, so they inherit the
    # enclosing object's (via file_default_package, else the threaded context).
    pkg = (
        (node.package or node.file_default_package or referrer_pkg)
        if node.type == TYPE_OBJECT
        else referrer_pkg
    )
    type_def = registry.find(node.type, node.sub_type)
    if type_def is not None:
        for desc in type_def.references:
            # ADR-0039: resolving — a reference attr (e.g. @objectRef/@through) may be
            # inherited via extends; read the effective value (mirrors the TS
            # ``node.attr``, which resolves — validation-registry.ts:66). The recursive
            # walk below stays own (each node validated once at its declaration site).
            raw = node.get_meta_attr(desc.attr)
            if not isinstance(raw, str) or raw == "":
                continue  # absence is the required-attr pass's job
            entity_ref = raw.split(".", 1)[0] if desc.dotted_field_path else raw
            # ADR-0042: bare refs resolve package-local against the enclosing object.
            target = ctx.symbols.resolve_object(entity_ref, pkg)
            # Qualify the node name with its owning entity (e.g. "Order.items") so the error
            # is locatable from the message alone, not just the source envelope.
            qname = f"{node.parent.name}.{node.name}" if node.parent and node.parent.name else node.name
            if target is None:
                ctx.error(
                    desc.error_code, node,
                    f'{node.type}.{node.sub_type} "{qname}" @{desc.attr} "{raw}" '
                    f"does not resolve to an object.{did_you_mean_hint(ctx.root, entity_ref)}",
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
                    f'{node.type}.{node.sub_type} "{qname}" @{desc.attr} "{raw}" '
                    f"resolves to {target.type}.{target.sub_type}, not a {want}.",
                )
        if type_def.validate is not None:
            type_def.validate(node, ctx)
    # ADR-0039 sanctioned own: the recursive validation walk visits each DECLARED
    # node once at its declaration site (own children); inherited nodes are
    # validated where they are declared. Mirrors the TS ``node.ownChildren()`` walk.
    for child in node.own_children():
        _walk(child, registry, ctx, pkg)
