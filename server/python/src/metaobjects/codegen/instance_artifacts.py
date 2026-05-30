"""Guard for the abstract concept (mirrors the TS instance-artifacts module).

An abstract entity must never produce instance/write artifacts (routers, filter
allowlists, CREATE TABLE DDL). The Pydantic base *model* is a separate, configurable
shape concern (emit_abstract_shapes, default on) handled in entity_model.
"""
from metaobjects.meta.core.object.meta_object import MetaObject


def is_abstract(entity: MetaObject) -> bool:
    return entity.is_abstract is True


def emits_instance_artifacts(entity: MetaObject) -> bool:
    return not is_abstract(entity)
