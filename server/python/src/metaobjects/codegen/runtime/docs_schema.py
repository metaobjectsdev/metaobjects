"""The MODEL-ONLY ``agent/schema.md``: the rows layer and the page data, built from the model.

Mirrors the TypeScript ``agent-schema-rows.ts`` and ``agent-schema-page.ts`` (the
``physical: false`` page). TypeScript builds its rows from the expected schema; a port
without it builds them from the model with its own naming helpers (design call 17 of
``fixtures/docs-page-conformance/``): a table per concrete object whose primary source is a
writable table (abstract bases, sourceless values and ``@unmanaged`` tables have none; a TPH
subtype shares its base's table and adds its own columns after the base's, nullable), a view
per object whose primary source is a view. The page carries no SQL type, default, index,
check, constraint name or referential action: the model cannot know them.

Rows and page data are plain dicts so they compare as JSON values against the corpus.
"""
from __future__ import annotations

import re
from typing import Any

from metaobjects.codegen.instance_artifacts import is_abstract
from metaobjects.codegen.model_walk import is_required
from .docs_requirements import GENERATED_MARKER, locale_sorted
from metaobjects.codegen.type_map import effective_enum_values
from metaobjects.documentation.doc_constants import DOC_ATTR_DESCRIPTION
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.identity.identity_constants import (
    GENERATION_INCREMENT,
    GENERATION_UUID,
    IDENTITY_ATTR_FIELDS,
    IDENTITY_ATTR_GENERATION,
    IDENTITY_REFERENCE_ATTR_ENFORCE,
    IDENTITY_REFERENCE_ATTR_REFERENCES,
    IDENTITY_SUBTYPE_REFERENCE,
)
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.core.object.object_constants import (
    OBJECT_ATTR_DISCRIMINATOR,
    OBJECT_ATTR_DISCRIMINATOR_VALUE,
    OBJECT_SUBTYPE_REPORT,
)
from metaobjects.meta.core.relationship.relationship_constants import (
    CARDINALITY_MANY,
    CARDINALITY_ONE,
    RELATIONSHIP_ATTR_CARDINALITY,
    RELATIONSHIP_ATTR_OBJECT_REF,
    RELATIONSHIP_ATTR_ON_DELETE,
    RELATIONSHIP_ATTR_THROUGH,
)
from metaobjects.meta.meta_data import MetaData
from metaobjects.meta.persistence.origin import origin_constants as oc
from metaobjects.meta.persistence.source.meta_source import MetaSource
from metaobjects.naming import (
    apply_column_naming_strategy,
    naming_rules_of,
    resolve_column_name,
    resolve_flattened_column_name,
)
from metaobjects.naming_refs import ref_target, split_child_tail
from metaobjects.shared.base_types import TYPE_IDENTITY, TYPE_ORIGIN, TYPE_RELATIONSHIP
from metaobjects.source_resolution import primary_rdb_source

AGENT_SCHEMA_PAGE_REF = "agent/schema.md"

_SOURCE_KIND_VIEW = "view"


def is_report(obj: MetaObject) -> bool:
    return obj.sub_type == OBJECT_SUBTYPE_REPORT


# --- the model, as rows ---------------------------------------------------------------


def row_key(name: str, schema: str | None) -> str:
    """The key ``declaredBy`` uses: what a page heading prints, without the backticks."""
    return name if schema is None else f"{schema}.{name}"


def _objects(root: MetaData) -> list[MetaObject]:
    return [c for c in root.children() if isinstance(c, MetaObject)]


def _description(node: MetaData) -> str | None:
    v = node.get_meta_attr(DOC_ATTR_DESCRIPTION)
    return v if isinstance(v, str) and v != "" else None


def _discriminator_base(entity: MetaData) -> MetaData | None:
    """The ``@discriminator``-bearing ANCESTOR of *entity*, or ``None``."""
    ancestor = entity.super_data
    while ancestor is not None:
        # ADR-0039 sanctioned own: explicit super-resolution walk, each ancestor's own attr.
        if ancestor.attr(OBJECT_ATTR_DISCRIMINATOR) is not None:
            return ancestor
        ancestor = ancestor.super_data
    return None


def _is_tph_subtype(entity: MetaData) -> bool:
    return (
        entity.get_meta_attr(OBJECT_ATTR_DISCRIMINATOR_VALUE) is not None
        and _discriminator_base(entity) is not None
    )


def _tph_concrete_subtypes(base: MetaObject, objects: list[MetaObject]) -> list[MetaObject]:
    if base.get_meta_attr(OBJECT_ATTR_DISCRIMINATOR) is None:
        return []
    return [
        o
        for o in objects
        if not is_abstract(o)
        and o.get_meta_attr(OBJECT_ATTR_DISCRIMINATOR_VALUE) is not None
        and _discriminator_base(o) is base
    ]


def _identity_fields(identity: MetaData) -> list[str]:
    v = identity.get_meta_attr(IDENTITY_ATTR_FIELDS)
    if isinstance(v, str):
        return [s.strip() for s in v.split(",") if s.strip()]
    return [str(x) for x in v] if isinstance(v, (list, tuple)) else []


def _find_field(obj: MetaObject, name: str) -> MetaField | None:
    return obj.find_field(name)


def _column_row(field: MetaData, is_pk: bool, generation: str | None, name: str) -> dict[str, Any]:
    col: dict[str, Any] = {"name": name, "nullable": not is_pk and not is_required(field)}
    if is_pk and generation in (GENERATION_INCREMENT, GENERATION_UUID):
        col["identity"] = generation
    description = _description(field)
    if description is not None:
        col["description"] = description
    return col


def _flattened(field: MetaField) -> bool:
    return (
        field.sub_type == fc.FIELD_SUBTYPE_OBJECT
        and field.get_meta_attr(fc.FIELD_ATTR_STORAGE) == fc.STORAGE_FLATTENED
    )


def _field_columns(field: MetaField, is_pk: bool, generation: str | None) -> list[dict[str, Any]]:
    if _flattened(field):
        target = ref_target(field, fc.FIELD_ATTR_OBJECT_REF)
        if not isinstance(target, MetaObject):
            return []
        return [
            _column_row(nested, False, None, resolve_flattened_column_name(field, nested))
            for nested in target.fields()
        ]
    return [_column_row(field, is_pk, generation, resolve_column_name(field))]


def _target_columns(ref: MetaData, target: MetaObject) -> list[str]:
    """The referenced key's columns: an explicit dotted tail on ``@references``, else the
    target's primary identity (its first field), else ``id``."""
    raw = ref.get_meta_attr(IDENTITY_REFERENCE_ATTR_REFERENCES)
    tail = split_child_tail(raw)[1] if isinstance(raw, str) else ""
    explicit = [s.strip() for s in tail.lstrip(".").split(",") if s.strip()]
    if explicit:
        names = explicit
    else:
        identity = target.primary_identity()
        pk = _identity_fields(identity) if identity is not None else []
        names = [pk[0] if pk else "id"]
    out = []
    for name in names:
        f = _find_field(target, name)
        out.append(resolve_column_name(f) if f is not None else apply_column_naming_strategy(name, naming_rules_of(target).columns))
    return out


def _foreign_keys(
    entity: MetaObject, objects: list[MetaObject], table_of: dict[str, str]
) -> list[dict[str, Any]]:
    refs: list[tuple[MetaObject, MetaData]] = [
        (entity, c) for c in entity.children() if c.type == TYPE_IDENTITY and c.sub_type == IDENTITY_SUBTYPE_REFERENCE
    ]
    if entity.get_meta_attr(OBJECT_ATTR_DISCRIMINATOR) is not None:
        base_names = {r.name for _h, r in refs}
        for sub in _tph_concrete_subtypes(entity, objects):
            for c in sub.children():
                if c.type == TYPE_IDENTITY and c.sub_type == IDENTITY_SUBTYPE_REFERENCE and c.name not in base_names:
                    refs.append((sub, c))
    fks: list[dict[str, Any]] = []
    for holder, ref in refs:
        if ref.get_meta_attr(IDENTITY_REFERENCE_ATTR_ENFORCE) is False:
            continue  # a logical-only reference is no constraint
        target = ref_target(ref, IDENTITY_REFERENCE_ATTR_REFERENCES)
        if not isinstance(target, MetaObject):
            continue
        ref_table = table_of.get(target.resolution_key())
        if not ref_table:
            continue
        names = _identity_fields(ref)
        if not names:
            continue
        columns = []
        for name in names:
            f = _find_field(holder, name)
            columns.append(resolve_column_name(f) if f is not None else apply_column_naming_strategy(name, naming_rules_of(holder).columns))
        fk = {"columns": columns, "refTable": ref_table, "refColumns": _target_columns(ref, target)}
        if fk not in fks:  # two subtypes may declare the same column: one constraint
            fks.append(fk)
    return fks


def _primary(entity: MetaObject) -> MetaSource | None:
    return primary_rdb_source(entity)


def schema_rows(root: MetaData) -> dict[str, Any]:
    """The rows layer of the model-only schema page: tables and views sorted by name (code
    points, as the snapshot file sorts them), a table's columns and keys in declaration order,
    and ``declaredBy`` (each table or view -> the declaring object)."""
    objects = _objects(root)
    # Pass 1: which objects own a table, and which are only an FK target.
    entities: list[tuple[MetaObject, MetaSource]] = []
    target_only: list[tuple[MetaObject, MetaSource]] = []
    tph_members: list[tuple[MetaObject, MetaData]] = []
    for obj in objects:
        base = _discriminator_base(obj)
        if base is not None and (is_abstract(obj) or _is_tph_subtype(obj)):
            tph_members.append((obj, base))
            continue
        if is_abstract(obj):
            continue
        if not any(isinstance(c, MetaSource) and c.is_writable() for c in obj.children()):
            continue
        source = _primary(obj)
        if source is None:
            continue
        # ADR-0039 sanctioned own: @unmanaged is read off the object's OWN writable source.
        own = next((c for c in obj.own_children() if isinstance(c, MetaSource) and c.is_writable()), None)
        if own is not None and own.is_unmanaged():
            target_only.append((obj, source))
            continue
        entities.append((obj, source))
    table_of: dict[str, str] = {o.resolution_key(): s.physical_name() for o, s in [*entities, *target_only]}
    for member, base in tph_members:
        name = table_of.get(base.resolution_key())
        if name is not None and member.resolution_key() not in table_of:
            table_of[member.resolution_key()] = name

    tables: list[dict[str, Any]] = []
    declared: dict[str, str] = {}
    for entity, source in entities:
        identity = entity.primary_identity()
        pk_names = _identity_fields(identity) if identity is not None else []
        generation = identity.get_meta_attr(IDENTITY_ATTR_GENERATION) if identity is not None else None
        generation = generation if isinstance(generation, str) else None
        primary_key = []
        for name in pk_names:
            f = _find_field(entity, name)
            primary_key.append(resolve_column_name(f) if f is not None else apply_column_naming_strategy(name, naming_rules_of(entity).columns))
        columns: list[dict[str, Any]] = []
        for field in entity.fields():
            if field.is_derived():
                continue
            columns.extend(_field_columns(field, field.name in pk_names, generation if field.name in pk_names else None))
        if entity.get_meta_attr(OBJECT_ATTR_DISCRIMINATOR) is not None:
            existing = {c["name"] for c in columns}
            base_fields = {f.name for f in entity.fields()}
            for sub in _tph_concrete_subtypes(entity, objects):
                for field in sub.fields():
                    if field.name in base_fields or field.is_derived():
                        continue
                    col = _column_row(field, False, None, resolve_column_name(field))
                    if col["name"] in existing:
                        continue
                    col["nullable"] = True  # a row of any other subtype stores NULL here
                    columns.append(col)
                    existing.add(col["name"])
        table: dict[str, Any] = {"name": source.physical_name()}
        schema = source.schema()
        if schema is not None:
            table["schema"] = schema
        description = _description(entity)
        if description is not None:
            table["description"] = description
        table["primaryKey"] = primary_key
        table["columns"] = columns
        table["foreignKeys"] = _foreign_keys(entity, objects, table_of)
        tables.append(table)
        declared[row_key(table["name"], schema)] = entity.resolution_key()

    views: list[dict[str, Any]] = []
    for obj in objects:
        if is_abstract(obj):
            continue
        source = _primary(obj)
        if source is None or source.effective_kind() != _SOURCE_KIND_VIEW:
            continue
        view: dict[str, Any] = {"name": source.physical_name()}
        schema = source.schema()
        if schema is not None:
            view["schema"] = schema
        key = row_key(view["name"], schema)
        if key in declared:
            continue
        views.append(view)
        declared[key] = obj.resolution_key()

    tables.sort(key=lambda t: t["name"])
    views.sort(key=lambda v: v["name"])
    return {"tables": tables, "views": views, "declaredBy": dict(sorted(declared.items()))}


# --- the page, from rows and the model ------------------------------------------------


def _md_cell_free(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _cols(names: list[str]) -> str:
    return "—" if not names else ", ".join(f"`{c}`" for c in names)


def _key_cell(table: dict[str, Any], column: dict[str, Any]) -> str:
    roles: list[str] = []
    if column["name"] in table["primaryKey"]:
        roles.append("PK (composite)" if len(table["primaryKey"]) > 1 else "PK")
    fk = next((f for f in table["foreignKeys"] if column["name"] in f["columns"]), None)
    if fk is not None:
        roles.append(f"FK → `{fk['refTable']}`")
    return " · ".join(roles)


def _lineage_of(field: MetaField) -> str | None:
    # ADR-0039 sanctioned own: an origin.* NEVER inherits.
    origin = next((c for c in field.own_children() if c.type == TYPE_ORIGIN), None)
    if origin is None:
        return None

    def text(name: str) -> str | None:
        v = origin.authored_attr(name)
        return v if isinstance(v, str) and v != "" else None

    sub = origin.sub_type
    if sub == oc.ORIGIN_SUBTYPE_PASSTHROUGH:
        src, via = text(oc.ORIGIN_ATTR_FROM), text(oc.ORIGIN_ATTR_VIA)
        return f"passthrough from `{src or '?'}`" + ("" if via is None else f" via `{via}`")
    if sub == oc.ORIGIN_SUBTYPE_AGGREGATE:
        agg = text(oc.ORIGIN_ATTR_AGG) or "?"
        of, via = text(oc.ORIGIN_ATTR_OF), text(oc.ORIGIN_ATTR_VIA)
        return f"`{agg}`" + ("" if of is None else f" of `{of}`") + ("" if via is None else f" via `{via}`")
    if sub == oc.ORIGIN_SUBTYPE_FIRST:
        of, via, order = text(oc.ORIGIN_ATTR_OF), text(oc.ORIGIN_ATTR_VIA), text(oc.ORIGIN_ATTR_ORDER_BY)
        return (
            "first"
            + ("" if of is None else f" `{of}`")
            + ("" if via is None else f" via `{via}`")
            + ("" if order is None else f" ordered by `{order}`")
        )
    if sub == oc.ORIGIN_SUBTYPE_COMPUTED:
        return "computed from a declared `@expr`"
    return f"`origin.{sub}`"


def _cardinality_phrase(cardinality: object, through: object) -> str:
    if cardinality == CARDINALITY_MANY:
        return "many-to-many" if isinstance(through, str) and through != "" else "one-to-many"
    if cardinality == CARDINALITY_ONE:
        return "many-to-one"
    return "cardinality not declared"


def _relationship_lines(objects: list[MetaObject]) -> list[str]:
    out: list[str] = []
    for obj in objects:
        for rel in (c for c in obj.children() if c.type == TYPE_RELATIONSHIP):
            cardinality = rel.get_meta_attr(RELATIONSHIP_ATTR_CARDINALITY)
            target = rel.authored_attr(RELATIONSHIP_ATTR_OBJECT_REF)
            through = rel.authored_attr(RELATIONSHIP_ATTR_THROUGH)
            on_delete = rel.get_meta_attr(RELATIONSHIP_ATTR_ON_DELETE)
            parts = [f"`{obj.resolution_key()}.{rel.name}`", f"`{rel.sub_type}`"]
            parts.append(f"{_cardinality_phrase(cardinality, through)} → `{target if target is not None else '?'}`")
            if isinstance(through, str) and through != "":
                parts.append(f"through `{through}`")
            if isinstance(on_delete, str) and on_delete != "":
                parts.append(f"on delete `{on_delete}`")
            out.append(" · ".join(parts))
    return out


def _enum_rows(objects: list[MetaObject]) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for obj in objects:
        for field in obj.fields():
            if field.sub_type != fc.FIELD_SUBTYPE_ENUM:
                continue
            members = effective_enum_values(field)
            if not members:
                continue
            int_map = field.get_meta_attr(fc.FIELD_ATTR_INT_VALUE_MAP)
            if isinstance(int_map, dict):
                storage = "int-backed (" + ", ".join(f"{m}={int_map[m]}" for m in members) + ")"
            else:
                storage = "string-backed"
            rows.append(
                {
                    "field": f"{obj.resolution_key()}.{field.name}",
                    "members": ", ".join(f"`{m}`" for m in members),
                    "storage": storage,
                }
            )
    return rows


def agent_schema_page_data(root: MetaData, rows: dict[str, Any]) -> dict[str, Any] | None:
    """The data ``agent/schema.md.mustache`` renders (``physical: false``), built from the rows
    and the model alone. ``None`` when there is no table and no view: no page."""
    if not rows["tables"] and not rows["views"]:
        return None
    objects = _objects(root)
    table_keys = {row_key(t["name"], t.get("schema")) for t in rows["tables"]}
    view_keys = {row_key(v["name"], v.get("schema")) for v in rows["views"]}

    table_backed: list[MetaObject] = []
    declared_by: dict[str, dict[str, tuple[str, str]]] = {}
    view_lineage: dict[str, list[dict[str, str]]] = {}
    report_views: set[str] = set()
    for obj in objects:
        source = _primary(obj)
        if source is None:
            continue
        key = row_key(source.physical_name(), source.schema())
        is_table = key in table_keys
        if not is_table and key not in view_keys:
            continue
        # An abstract base that declares the source its concrete child inherits resolves to
        # that child's table: it is in the schema but is no table-backed object.
        if is_table and not is_abstract(obj):
            table_backed.append(obj)
        if not is_table and is_report(obj):
            report_views.add(key)
        mapping = declared_by.setdefault(key, {})
        lineage: list[dict[str, str]] = []
        for field in obj.fields():
            column = resolve_column_name(field)
            # A TPH base and its subtypes share one table: first writer wins.
            if column not in mapping:
                mapping[column] = (field.name, f"{field.type}.{field.sub_type}")
            text = _lineage_of(field)
            if text is not None:
                lineage.append({"column": column, "text": text})
        if lineage:
            view_lineage[key] = lineage

    relationships = _relationship_lines(objects)
    enums = _enum_rows(table_backed)
    any_description = any(
        t.get("description", "") != "" or any(c.get("description", "") != "" for c in t["columns"])
        for t in rows["tables"]
    )

    tables = []
    for table in locale_sorted(rows["tables"], lambda t: t["name"]):
        key = row_key(table["name"], table.get("schema"))
        mapping = declared_by.get(key, {})
        described = [c for c in table["columns"] if c.get("description", "") != ""]
        fks = [f"{_cols(f['columns'])} → `{f['refTable']}`({_cols(f['refColumns'])})" for f in table["foreignKeys"]]
        entry: dict[str, Any] = {"heading": f"`{key}`"}
        if key in rows["declaredBy"]:
            entry["tableDeclaredBy"] = rows["declaredBy"][key]
        if table.get("description", "") != "":
            entry["tableDescription"] = _md_cell_free(table["description"])
        entry["columns"] = [
            {
                "name": c["name"],
                "fieldCell": f"`{mapping[c['name']][0]}`" if c["name"] in mapping else "",
                "declaredCell": f"`{mapping[c['name']][1]}`" if c["name"] in mapping else "",
                "sqlTypeCell": "",
                "nullCell": "yes" if c["nullable"] else "no",
                "defaultCell": "",
                "keyCell": _key_cell(table, c),
            }
            for c in table["columns"]
        ]
        entry.update(
            hasDescribed=len(described) > 0,
            described=[{"name": c["name"], "text": _md_cell_free(c["description"])} for c in described],
            hasIndexes=False,
            indexes=[],
            hasForeignKeys=len(fks) > 0,
            foreignKeys=fks,
            hasChecks=False,
            checks=[],
        )
        tables.append(entry)

    views = []
    for view in locale_sorted(rows["views"], lambda v: v["name"]):
        key = row_key(view["name"], view.get("schema"))
        lineage = view_lineage.get(key, [])
        entry = {"heading": f"`{key}`"}
        if key in rows["declaredBy"]:
            entry["viewDeclaredBy"] = rows["declaredBy"][key]
        entry["hasLineage"] = len(lineage) > 0
        entry["lineage"] = lineage
        views.append(entry)

    return {
        "generatedMarker": GENERATED_MARKER,
        "physical": False,
        "dialect": "",
        "descriptionNudge": not any_description and len(rows["tables"]) > 0,
        "hasTables": len(tables) > 0,
        "tables": tables,
        "hasViews": len(views) > 0,
        "hasReportView": any(row_key(v["name"], v.get("schema")) in report_views for v in rows["views"]),
        "views": views,
        "hasRelationships": len(relationships) > 0,
        "relationships": relationships,
        "hasEnums": len(enums) > 0,
        "enums": enums,
    }
