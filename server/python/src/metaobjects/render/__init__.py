"""Render-tier engine: the build-time template drift-check ``verify`` (FR-004) and
the FR-010 tolerant ``recover`` parser."""

from metaobjects.render.recover import (
    FieldKind,
    FieldRecovery,
    FieldSpec,
    Format,
    RecoverOptions,
    RecoverOutcome,
    RecoverSchema,
    RecoveryReport,
    RecoveryResult,
    Tolerance,
    recover,
    recover_map,
)
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
    "FieldKind",
    "FieldRecovery",
    "FieldSpec",
    "Format",
    "InMemoryProvider",
    "PayloadField",
    "Provider",
    "RecoverOptions",
    "RecoverOutcome",
    "RecoverSchema",
    "RecoveryReport",
    "RecoveryResult",
    "Tolerance",
    "VerifyError",
    "recover",
    "recover_map",
    "verify",
]
