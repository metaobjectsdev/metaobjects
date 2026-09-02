"""Guard for the abstract concept (mirrors the TS instance-artifacts module).

An abstract entity must never produce instance/write artifacts (routers, filter
allowlists, CREATE TABLE DDL). The Pydantic base *model* is a separate concern: this
port ALWAYS emits it (concretes subclass it). It was described here as "a configurable
shape concern (emit_abstract_shapes, default on) handled in entity_model" — that config
field was read by nothing and entity_model never consulted it, so `GenConfig` now
refuses to accept a value it cannot honour.
"""
from metaobjects.meta.core.object.meta_object import MetaObject


def is_abstract(entity: MetaObject) -> bool:
    return entity.is_abstract is True


def emits_instance_artifacts(entity: MetaObject) -> bool:
    return not is_abstract(entity)
