"""Abstract node base — Python port of the typed-tree MetaData (ADR-0002)."""
from __future__ import annotations

from typing import Callable, Optional, TypeVar, cast

from ..attr_class_map import attr_class_for
from ..shared.base_types import SUBTYPE_BASE, TYPE_ATTR
from ..shared.separators import PACKAGE_SEP
from ..shared.structural import KEY_IS_ARRAY
from ..source import CodeSource, ErrorSource

T = TypeVar("T")


class MetaData:
    def __init__(self, type_: str, sub_type: str, name: str) -> None:
        self.type = type_
        self.sub_type = sub_type
        self.name = name
        self.package: Optional[str] = None
        # The file-default package captured at PARSE time (the package declared
        # on the owning file's root). Distinct from ``package`` (which an object
        # node leaves unset — the parser does not fold the file-default package
        # onto an object's own package). Used by super-resolution to match a
        # cross-package fully-qualified ``extends`` over the MERGED tree, where
        # per-file root packages are no longer reachable via the parent chain.
        # Mirrors TS ``MetaData.fileDefaultPackage`` / ``resolutionKey()``.
        self.file_default_package: Optional[str] = None
        self.super_ref: Optional[str] = None
        self.super_data: Optional[MetaData] = None
        self.is_abstract = False
        self.is_overlay = False
        self.is_array = False
        self.parent: Optional[MetaData] = None
        self._attr_nodes: dict[str, MetaData] = {}  # name -> MetaAttr instance
        self._children: list[MetaData] = []
        self._cache: dict[str, object] = {}
        self._frozen = False
        # FR5a / ADR-0009 — provenance envelope. Always populated; defaults
        # to CodeSource for programmatic / test construction. Loader phases
        # (parser, merge) overwrite via set_source during the tree walk.
        self._source: ErrorSource = CodeSource.DEFAULT

    @property
    def frozen(self) -> bool:
        return self._frozen

    @property
    def source(self) -> ErrorSource:
        """FR5a / ADR-0009 — provenance envelope for this node. Always populated."""
        return self._source

    def set_source(self, src: ErrorSource) -> None:
        """Loader-internal: assign provenance. Honors the frozen-guard.

        Called by parser / merge phases as they build the tree. Programmatic
        callers (tests, plugins) may pass any envelope explicitly.
        """
        self._require_mutable()
        self._source = src

    def fqn(self) -> str:
        """Own FQN: ``package::name`` if own package is set, else just ``name``."""
        return self.name if not self.package else f"{self.package}{PACKAGE_SEP}{self.name}"

    def resolution_key(self) -> str:
        """Package-folded FQN: ``<pkg>::<name>`` where *pkg* is, in order:

          1. this node's own ``package`` (when declared), else
          2. its ``file_default_package`` (the file's root package captured at
             PARSE time), else
          3. the nearest ancestor's ``package`` (a programmatic fallback for
             hand-built trees / plugins).

        Returns the bare name when none is available.

        This is the Python equivalent of the C#/TS ``ResolutionKey`` and is
        consistent with the #37 super-resolution fix (``node.package or
        node.file_default_package or ctx_pkg``). It is the package-folded form a
        nested field's ``@objectRef`` uses AND the key the runtime object model
        binds on (``ObjectClassRegistry`` / ``MetaObject.new_instance``). Distinct
        from ``fqn()``, which stays bare for objects (the parser does not fold the
        file-default package onto an object's own ``package``).

        The ``file_default_package`` step is load-bearing: after a multi-file
        MERGE an object node carries no own ``package`` and its parent is the
        single merged root (also package-less), so the ancestor walk alone would
        fall through to the bare name and bind the WRONG (package-less) registry
        key. Folding the file-default package keeps the binding correct
        regardless of merge order.
        """
        pkg = self.package or self.file_default_package
        if not pkg:
            node = self.parent
            while node is not None:
                if node.package:
                    pkg = node.package
                    break
                node = node.parent
        if pkg:
            return f"{pkg}{PACKAGE_SEP}{self.name}"
        return self.name

    def _require_mutable(self) -> None:
        if self._frozen:
            raise RuntimeError(f"Cannot mutate frozen MetaData {self.fqn()}")

    def set_attr(self, name: str, value: object, sub_type: str | None = None) -> None:
        self._require_mutable()
        resolved_sub = sub_type if sub_type is not None else SUBTYPE_BASE
        ctor = attr_class_for(resolved_sub)
        # attr_class_for always returns a MetaData subclass at runtime; cast for type safety.
        attr = cast("MetaData", ctor(TYPE_ATTR, resolved_sub, name))
        attr.parent = self
        attr.set_value(value)  # type: ignore[attr-defined]
        self._attr_nodes[name] = attr

    def own_meta_attr(self, name: str) -> Optional[MetaData]:
        return self._attr_nodes.get(name)

    def own_meta_attrs(self) -> list[MetaData]:
        return list(self._attr_nodes.values())

    def attr(self, name: str) -> object:
        """OWN-ONLY attr value for *name*, or ``None``.

        ADR-0039 — NAMING INVERSION (Python vs TS/Java): in Python ``attr()`` is
        OWN-ONLY (reads only this node's locally-declared attr, never the super
        chain), whereas TS/Java ``attr()`` RESOLVES. **Do not use ``attr()`` to
        read an effective/semantic property** (``@objectRef``/``@column``/
        ``@default``/``@maxLength``/``@precision``/``@storage``/``@required``/…) —
        a value inherited through this node's ``extends`` chain would be silently
        dropped. Use the resolving ``get_meta_attr(name)`` (or ``attrs().get(name)``)
        instead. ``attr()`` is legitimate ONLY for: own-mode canonical
        serialization, overlay/merge + super-resolution walks, validating the
        *own* declaration, and the deliberately-never-inherited ``@dbColumnType``.
        Every such call MUST carry a one-line comment naming the sanctioned case.
        """
        node = self._attr_nodes.get(name)
        return getattr(node, "value", None) if node is not None else None

    def get_meta_attr(self, name: str) -> object:
        """RESOLVING attr value for *name* — own + inherited via the ``extends``
        super chain (own wins on conflict), or ``None``.

        ADR-0039 — this is the default/effective read. Prefer it over ``attr()``
        (which is own-only in Python; see the inversion note there) for any
        semantic property that may be inherited from an abstract parent.
        """
        return self.attrs().get(name)

    def resolved_is_array(self) -> bool:
        """RESOLVING array-ness — the effective ``isArray`` for this node.

        ADR-0039 — mirrors the TS ``MetaData.resolvedIsArray()``. ``is_array`` is a
        native boolean property (not an attr), so it is resolved two ways: the
        native flag on this node OR any super in the chain has it set, OR the
        loaded-from-JSON ``@isArray`` attr resolves true through ``attrs()``.
        Reading the own ``is_array`` flag alone silently drops an array-ness
        inherited from an abstract parent field.
        """
        if self.is_array:
            return True
        node = self.super_data
        seen: set[MetaData] = {self}
        while node is not None and node not in seen:
            if node.is_array:
                return True
            seen.add(node)
            node = node.super_data
        return self.attrs().get(KEY_IS_ARRAY) is True

    def own_attrs(self) -> dict[str, object]:
        """Own attr value map — excludes inherited attrs."""
        return {
            name: getattr(node, "value", None)
            for name, node in self._attr_nodes.items()
            if getattr(node, "value", None) is not None
        }

    def attrs(self) -> dict[str, object]:
        """Effective attr value map: own + inherited via super chain (own wins on key conflict).

        Cycle-guarded and cached.
        """
        return self._cached("attrs", lambda: self._effective_attrs_inner({self}))

    def _effective_attrs_inner(self, visited: "set[MetaData]") -> dict[str, object]:
        """Compute effective attrs with cycle detection via *visited* set."""
        if self.super_data is None or self.super_data in visited:
            return self.own_attrs()
        visited.add(self.super_data)
        result = self.super_data._effective_attrs_inner(visited)
        # own attrs override super
        result.update(self.own_attrs())
        return result

    def add_child(self, child: "MetaData") -> None:
        self._require_mutable()
        child.parent = self
        self._children.append(child)

    def own_children(self) -> list["MetaData"]:
        """Own (locally declared) children — excludes children inherited via extends."""
        return list(self._children)

    def children(self) -> list["MetaData"]:
        """Effective children: own + inherited via the super chain, own shadowing super on (type, name).

        Cycle-guarded and cached (after freeze).
        """
        return self._cached("children", lambda: self._effective_children_inner({self}))

    def _effective_children_inner(
        self, visited: "set[MetaData]"
    ) -> list["MetaData"]:
        """Compute effective children with cycle detection via *visited* set."""
        if self.super_data is None or self.super_data in visited:
            # No super, or super already on the current path — skip to avoid cycle.
            result: list[MetaData] = list(self._children)
        else:
            visited.add(self.super_data)
            result = self.super_data._effective_children_inner(visited)
            # Own children that shadow NOTHING are appended only after the whole own
            # set has been matched — never inside the loop. Appending as we go made an
            # own child eligible to be shadowed by a LATER OWN SIBLING, which is not
            # what shadowing means: `extends` decides what a child overrides, and a
            # sibling is not a super. It cost a real shape, because the practical way
            # two children share a (type, name) is that BOTH ARE UNNAMED: a
            # write-through entity declares `source.rdb @role: primary` and `source.rdb
            # @role: replica`, both with name "", so on any such entity that also has a
            # super the primary was dropped from `children()` outright — no table for
            # `primary_rdb_source`, no names module, no router, and the runtime falling
            # through to the replica view. This is the TypeScript reference's
            # `appendQueue` (`meta-data.ts::_effectiveChildren`), which has always been
            # written this way; the divergence was this port's alone.
            append_queue: list[MetaData] = []
            for own in self._children:
                idx = next(
                    (i for i, c in enumerate(result)
                     if c.type == own.type and c.name == own.name),
                    None,
                )
                if idx is None:
                    append_queue.append(own)
                else:
                    result[idx] = own
            result.extend(append_queue)
        return result

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
            return cast(T, self._cache[key])
        value = compute()
        if self._frozen:
            self._cache[key] = value
        return value
