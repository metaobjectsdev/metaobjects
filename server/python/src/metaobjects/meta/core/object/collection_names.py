"""An object's collection name, in the object's own casing: its own ``@collectionName``, else the
project's pluralizer (``naming.collections``) over its name. Each artifact then applies its own
casing (a REST segment: snake_case; a reverse ``@via`` hop: lowerFirst). Mirrors the TypeScript
``collectionNameOf``.
"""
from __future__ import annotations

from metaobjects.meta.core.object.object_constants import OBJECT_ATTR_COLLECTION_NAME
from metaobjects.meta.meta_data import MetaData


def declared_collection_name(obj: MetaData) -> str | None:
    """The collection name *obj* declares itself; ``None`` when it declares none."""
    # ADR-0039: own — a collection name is the declaring object's alone; one inherited from an
    # abstract base would give every subtype one collection.
    own = obj.own_attrs().get(OBJECT_ATTR_COLLECTION_NAME)
    return own if isinstance(own, str) and own else None


def collection_name_of(obj: MetaData) -> str:
    """*obj*'s own ``@collectionName``, else the configured pluralizer over its name."""
    from metaobjects.naming import DEFAULT_PLURALIZER, naming_rules_of, pluralizer

    declared = declared_collection_name(obj)
    if declared is not None:
        return declared
    return pluralizer(naming_rules_of(obj).collections or DEFAULT_PLURALIZER)(obj.name)
