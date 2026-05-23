"""Render-tier engine (FR-004): the build-time template drift-check ``verify``."""

from metaobjects.render.verify import (
    ERR_OUTPUT_TAG_MISSING,
    ERR_PARTIAL_UNRESOLVED,
    ERR_REQUIRED_SLOT_UNUSED,
    ERR_VAR_NOT_ON_PAYLOAD,
    InMemoryProvider,
    PayloadField,
    Provider,
    VerifyError,
    verify,
)

__all__ = [
    "ERR_OUTPUT_TAG_MISSING",
    "ERR_PARTIAL_UNRESOLVED",
    "ERR_REQUIRED_SLOT_UNUSED",
    "ERR_VAR_NOT_ON_PAYLOAD",
    "InMemoryProvider",
    "PayloadField",
    "Provider",
    "VerifyError",
    "verify",
]
