"""ObjectManager — the store-neutral contract of the runtime persistence layer.

Cross-port shape mirrors the Java ``ObjectManager`` / ``ObjectManagerDB`` pair: this abstract
class is what generated and hand-written code is written against, and a concrete manager
supplies the store. :class:`~metaobjects.runtime.object_manager_db.ObjectManagerDb` is the
DB-API one (Postgres, SQLite, MySQL).

What lives here is what does not depend on a store:

* the method-based API (``find_by_id`` / ``find_many`` / ``count`` / ``create`` / ``update`` /
  ``delete`` / ``relate``) and the Filter shape;
* looking an object up by name and refusing what a report cannot do;
* ``@autoSet`` stamping (#203);
* :meth:`transaction`, which a store implements;
* persistence listeners (:class:`PersistenceListener`), notified around every write.

Write methods are template methods: the base refuses reports, stamps, notifies the listeners
and calls the store's ``_insert_row`` / ``_update_row`` / ``_delete_row``.
"""
from __future__ import annotations

import datetime as _dt
from abc import ABC, abstractmethod
from collections.abc import Iterable, Mapping
from contextlib import AbstractContextManager
from typing import Any

from ..meta.core.identity import identity_constants as ic
from ..meta.core.object.meta_object import MetaObject
from ..meta.core.object.object_constants import OBJECT_SUBTYPE_REPORT
from ..meta.core.reporting.report_read_model import report_read_model
from ..meta.meta_root import MetaRoot
from ..meta.persistence.source.meta_source import MetaSource
from ..naming import naming_rules_of
from .validator_runner import ValidationResult, run_validators
from .values import auto_set_fields, auto_set_stamp, coerce_key_value

# Filter shape:
#   {"field": "value"}                    → equality shortcut
#   {"field": {"eq": v, "gt": v, ...}}    → typed ops on a field
#   {"and": [filter, filter, ...]}        → top-level combinator
Filter = dict[str, Any]


class PersistenceListener:
    """Notified around every write a manager makes. Subclass and override what you need; every
    method does nothing by default (the Java ``PersistenceEventListener``).

    ``entity_name`` is the object's name as the manager API takes it. A ``before`` method runs
    before anything is written and may raise to refuse the write, which then does not happen;
    an ``after`` method runs once the store has the change. Inside
    :meth:`ObjectManager.transaction` an ``after`` method runs BEFORE the transaction commits,
    so an exception from it rolls the whole transaction back. A listener sees the data as the
    caller passed it (``on_before_*``) and the row as persisted (``on_after_*``, with
    ``@autoSet`` timestamps, generated keys and column defaults filled in)."""

    def on_before_create(self, entity_name: str, data: dict[str, Any]) -> None: ...

    def on_after_create(self, entity_name: str, row: dict[str, Any]) -> None: ...

    def on_before_update(self, entity_name: str, id_value: Any, data: dict[str, Any]) -> None: ...

    def on_after_update(self, entity_name: str, id_value: Any, row: dict[str, Any]) -> None:
        """Not called when no row matched the key."""

    def on_before_delete(self, entity_name: str, id_value: Any) -> None: ...

    def on_after_delete(self, entity_name: str, id_value: Any) -> None:
        """Not called when no row matched the key."""


class ObjectManager(ABC):
    """The persistence contract. Abstract: construct a concrete manager, e.g.
    ``ObjectManagerDb(root, driver)``."""

    def __new__(cls, *args: Any, **kwargs: Any) -> "ObjectManager":
        if cls is ObjectManager:
            raise TypeError(
                "ObjectManager is the abstract persistence contract and cannot be constructed. "
                "Construct ObjectManagerDb(root, driver) for a DB-API connection "
                "(metaobjects.runtime.ObjectManagerDb); write code against ObjectManager."
            )
        return super().__new__(cls)

    def __init__(self, root: MetaRoot) -> None:
        self._root = root
        # How a field with no explicit `@column` becomes a physical column name —
        # ADR-0058: THE one project setting, read from the loaded root
        # (`naming_rules_of`), so codegen's `names` generator and this runtime cannot
        # disagree about what a constant means.
        self._column_naming = naming_rules_of(root).columns
        self._entity_by_name: dict[str, MetaObject] = {}
        # ADR-0039 sanctioned own: top-level entity scan on the loader ROOT
        # (metadata.root is never extended, so own == effective) — mirrors the TS
        # object-manager (``this.metadata.ownChildren()``).
        for c in root.own_children():
            if isinstance(c, MetaObject):
                self._entity_by_name.setdefault(c.name, c)
        self._listeners: list[PersistenceListener] = []
        #: Per-field SQL type code from the most recent ``find_*`` query, keyed by metadata
        #: field name. Out-of-band SQL-type metadata for the serialization boundary (the
        #: int4-vs-int8 wire discriminator); the returned row values themselves stay native
        #: (ADR-0019). Single-query-scoped: overwritten by each query, so read it immediately
        #: after the query whose result you are serializing. Not safe to interleave
        #: concurrent queries on one manager instance (the row values are unaffected — only
        #: this discriminator is racy). A store with no such codes leaves it empty.
        self.last_column_oids: dict[str, int] = {}

    # --- Listeners -----------------------------------------------------------

    def add_listener(self, listener: PersistenceListener) -> None:
        """Register *listener*; it is notified, in registration order, around every write."""
        self._listeners.append(listener)

    def remove_listener(self, listener: PersistenceListener) -> None:
        """Unregister *listener* (a listener that was never added is ignored)."""
        if listener in self._listeners:
            self._listeners.remove(listener)

    def _notify(self, event: str, *args: Any) -> None:
        for listener in tuple(self._listeners):
            getattr(listener, event)(*args)

    # --- Transactions --------------------------------------------------------

    @abstractmethod
    def transaction(self) -> AbstractContextManager[None]:
        """``with om.transaction(): ...`` — every write made inside the block commits together
        when the (outermost) block ends and rolls back together when it raises. A block opened
        inside another joins it. Reads inside the block see the block's own writes."""

    # --- Public API ----------------------------------------------------------

    def validate(self, entity_name: str, data: Mapping[str, Any]) -> ValidationResult:
        """Validate ``data`` against ``entity_name``'s metadata — no store access, and
        nothing is raised for invalid data: the failures come back on the result. Mirrors
        the TS ``om.validate()``. The write methods do not call it; validate first when
        the data is untrusted."""
        return run_validators(self._declared_entity(entity_name), data)

    def find_by_id(self, entity_name: str, id_value: Any) -> dict[str, Any] | None:
        self._refuse_report("find_by_id", entity_name)
        entity = self._require_entity(entity_name)
        pk_field = self._primary_pk_field(entity)
        pk = entity.find_field(pk_field)
        if pk is not None:
            id_value = coerce_key_value(pk, id_value)
        rows = self.find_many(entity_name, {pk_field: id_value}, sort=None, limit=1, offset=None)
        return rows[0] if rows else None

    @abstractmethod
    def find_many(
        self,
        entity_name: str,
        filter: Filter | None = None,
        *,
        sort: Iterable[tuple[str, str]] | None = None,
        limit: int | None = None,
        offset: int | None = None,
    ) -> list[dict[str, Any]]:
        """The rows matching *filter*, as field-keyed dicts of native values."""

    @abstractmethod
    def count(self, entity_name: str, filter: Filter | None = None) -> int:
        """How many rows match *filter*."""

    @abstractmethod
    def relate(
        self, entity_name: str, record: dict[str, Any], relation_name: str
    ) -> list[dict[str, Any]] | dict[str, Any] | None:
        """Traverse a relationship from a source *record* to its related rows."""

    def create(self, entity_name: str, data: dict[str, Any]) -> dict[str, Any]:
        """INSERT a row through the runtime write path, returning the inserted row.

        ``data`` carries field-keyed values in their *native authoring forms*
        (the persistence-conformance ``op: roundtrip`` contract): a decimal /
        uuid / temporal as a string, a ``field.object`` as a dict, currency as an
        integer (minor units). Each value is coerced to the native Python type
        the store binds to the column's physical type, so the WRITE codec is
        exercised end-to-end. Server-defaulted columns the caller omits (e.g. a
        ``gen_random_uuid()`` PK) are left out of the INSERT and filled by the
        store; the full row — including the generated PK — is returned so a
        round-trip read can key off it.

        #203 — ``@autoSet`` stamping: EVERY ``onCreate`` AND ``onUpdate`` temporal
        column is stamped with a single shared ``now()`` (keyed off the column's
        type), OVERRIDING any caller-supplied value — so a fresh row's updated
        timestamp equals its created one. Use :meth:`insert_preserving` for the
        import/restore path that must keep original timestamps.
        """
        self._refuse_report("create", entity_name)
        entity = self._require_entity(entity_name)
        self._notify("on_before_create", entity_name, data)
        stamped = data
        # #203: stamp every onCreate AND onUpdate column with one shared now() (the
        # caller's value is ignored). No-op for entities that declare no @autoSet field.
        on_create, on_update = auto_set_fields(entity)
        if on_create or on_update:
            base = _dt.datetime.now(_dt.timezone.utc)
            stamped = {**data}
            for f in (*on_create, *on_update):
                stamped[f.name] = auto_set_stamp(f, base)
        row = self._insert_row(entity, entity_name, stamped)
        self._notify("on_after_create", entity_name, row)
        return row

    def insert_preserving(self, entity_name: str, data: dict[str, Any]) -> dict[str, Any]:
        """#203 escape hatch — INSERT that writes the ``@autoSet`` columns VERBATIM
        from *data*, skipping the ``now()`` stamping :meth:`create` applies.

        For import / restore / replication paths that must persist the ORIGINAL
        ``createdAt`` / ``updatedAt`` timestamps a row carried, not fresh ones.
        Every other column behaves exactly as :meth:`create` (same write codec,
        same TPH discriminator injection, same returned row, same listener events). For an
        entity that declares no ``@autoSet`` field this is identical to :meth:`create`.
        """
        self._refuse_report("insert_preserving", entity_name)
        entity = self._require_entity(entity_name)
        self._notify("on_before_create", entity_name, data)
        row = self._insert_row(entity, entity_name, data)
        self._notify("on_after_create", entity_name, row)
        return row

    def update(
        self,
        entity_name: str,
        id_value: Any,
        data: dict[str, Any],
        *,
        if_missing: str = "ignore",
    ) -> dict[str, Any] | None:
        """UPDATE a row by primary key through the runtime write path.

        ``data`` carries field-keyed values in the same *native authoring forms*
        as :meth:`create`, run through the SAME write codec the INSERT path uses.

        #203 — ``@autoSet`` stamping: every ``onUpdate`` temporal column is bumped
        to ``now()`` (overriding any caller value), while ``onCreate`` columns are
        stripped and never rewritten — a full-row update carrying a stale
        ``createdAt`` cannot clobber the write-once creation timestamp.

        Returns the updated row (mapped to metadata field names). When no row matched the
        (TPH-scoped) PK, behavior follows *if_missing* (mirrors the TS
        ``WriteOpts.ifMissing``): ``"ignore"`` (default) → ``None`` so a REST route renders
        404; ``"throw"`` → raise so the persistence DSL's ``expect-error`` op is satisfied.
        The discriminator is immutable, so a TPH subtype's patch strips it and the by-id write
        is scoped to the subtype (a cross-subtype id matches no row → the same not-found path).
        """
        self._refuse_report("update", entity_name)
        entity = self._require_entity(entity_name)
        self._notify("on_before_update", entity_name, id_value, data)
        stamped = data
        # #203 — @autoSet: bump every onUpdate column to now(), and NEVER rewrite an
        # onCreate column — strip it even if the caller supplied a (stale) value.
        # Omitting this onCreate-skip is the latent lost-update bug the issue calls
        # out. No-op for entities that declare no @autoSet field.
        on_create, on_update = auto_set_fields(entity)
        if on_create or on_update:
            base = _dt.datetime.now(_dt.timezone.utc)
            stamped = {**data}
            for f in on_create:
                stamped.pop(f.name, None)  # created_at is write-once — never overwritten on update
            for f in on_update:
                stamped[f.name] = auto_set_stamp(f, base)
        row = self._update_row(entity, entity_name, id_value, stamped, if_missing)
        if row is not None:
            self._notify("on_after_update", entity_name, id_value, row)
        return row

    def delete(self, entity_name: str, id_value: Any) -> bool:
        """DELETE a row by primary key through the runtime write path.

        Returns ``True`` when a row was deleted, ``False`` when the PK matched
        nothing. Mirrors the TS ``om.delete`` boolean outcome contract.
        """
        self._refuse_report("delete", entity_name)
        entity = self._require_entity(entity_name)
        self._notify("on_before_delete", entity_name, id_value)
        deleted = self._delete_row(entity, entity_name, id_value)
        if deleted:
            self._notify("on_after_delete", entity_name, id_value)
        return deleted

    # --- What a store supplies ----------------------------------------------

    @abstractmethod
    def _insert_row(
        self, entity: MetaObject, entity_name: str, data: dict[str, Any]
    ) -> dict[str, Any]:
        """INSERT *data* (already stamped where it should be) and return the stored row."""

    @abstractmethod
    def _update_row(
        self,
        entity: MetaObject,
        entity_name: str,
        id_value: Any,
        data: dict[str, Any],
        if_missing: str,
    ) -> dict[str, Any] | None:
        """UPDATE the row keyed *id_value* and return it, or answer a missing row as
        *if_missing* says (``"ignore"`` → ``None``, ``"throw"`` → raise)."""

    @abstractmethod
    def _delete_row(self, entity: MetaObject, entity_name: str, id_value: Any) -> bool:
        """DELETE the row keyed *id_value*; ``True`` when one was deleted."""

    # --- Helpers -------------------------------------------------------------

    def _declared_entity(self, name: str) -> MetaObject:
        """The object node exactly as loaded (a report is NOT swapped for its read model)."""
        e = self._entity_by_name.get(name)
        if e is None:
            raise KeyError(f"No entity named '{name}' in loaded metadata")
        return e

    def _require_entity(self, name: str) -> MetaObject:
        """The object the runtime reads and writes through. FR-044: a report declares no
        fields (its read shape is derived), so it is read through its detached read model
        (:func:`report_read_model`) — ordinary derived ``field.*`` children plus a copy of
        its own read-only source — and everything downstream (column list, filter and sort
        resolution, read coercion, table resolution) sees an ordinary view-backed object.
        The model is built once per report node and never joins the loaded tree.

        A report with no read-only source of its own has no view (Table A), so there is
        nothing to read: refused as not served rather than read from a table nobody made."""
        e = self._declared_entity(name)
        if e.sub_type != OBJECT_SUBTYPE_REPORT:
            return e
        try:
            model = report_read_model(e, self._root)
        except ValueError as exc:
            raise ValueError(f"Report '{name}' cannot be read: {exc}") from exc
        # ADR-0039: own — the read model is a detached object that extends nothing; its
        # sources are exactly the one copy report_read_model() added, so there is no
        # inherited layer for an own read to drop.
        if not any(isinstance(c, MetaSource) for c in model.own_children()):
            raise ValueError(
                f"Report '{name}' is not served: it declares no read-only source, "
                f"so it has no view to read"
            )
        return model

    def _refuse_report(self, op: str, name: str) -> None:
        """Refuse an operation a report cannot support — get-by-id, relationship
        traversal and every write — on the DECLARED subtype, before anything else is
        looked at (a sourceless report included: it is read-only, not merely unserved)."""
        if self._declared_entity(name).sub_type == OBJECT_SUBTYPE_REPORT:
            raise ValueError(
                f"{op} is not supported on '{name}': a report is read-only and has no identity "
                f"(it is a view over aggregates; only find_many and count read it)"
            )

    def primary_key_field(self, entity_name: str) -> str:
        """The single-field primary-key NAME for an entity, from its
        ``identity.primary`` ``@fields``. ``op: roundtrip`` reads the inserted
        row back by this key (composite PKs are not supported by roundtrip)."""
        self._refuse_report("primary_key_field", entity_name)
        return self._primary_pk_field(self._require_entity(entity_name))

    def _primary_pk_field(self, entity: MetaObject) -> str:
        pi = entity.primary_identity()
        if pi is None:
            raise ValueError(f"Entity '{entity.name}' has no primary identity")
        raw = pi.get_meta_attr(ic.IDENTITY_ATTR_FIELDS)  # ADR-0039 resolving: identity @fields may be inherited
        if isinstance(raw, str):
            return raw
        if isinstance(raw, (list, tuple)) and raw:
            return str(raw[0])
        raise ValueError(f"Entity '{entity.name}' primary identity has no fields")
