"""Source subtype vocabulary (colocated).

Source v2 (ADR-0007): paradigm subtype ``rdb`` with @table/@kind/@role/@schema attrs.
Read-only-ness is derived from @kind (view/materializedView/storedProc/tableFunction
are read-only; table — the default — is writable). Multiple sources per object are
allowed (write-through CQRS) but exactly one must have role == "primary".

FR-016 / ADR-0018 — per-kind physical-name aliases. The source's logical name is the
bare structural ``name`` field every MetaData node carries (NOT an @-attr; ``@name``
would collide with ``ERR_RESERVED_ATTR``). The physical SQL name is one of the
kind-aware aliases (@table / @view / @materializedView / @proc / @function), all
filling the same internal slot. See :data:`PHYSICAL_NAME_ATTR_BY_KIND` and
:meth:`MetaSource.physical_name` for the four-step resolution rule.
"""
from ....shared.base_types import SUBTYPE_BASE

# --- Source v2 paradigm subtype --------------------------------------------
SOURCE_SUBTYPE_RDB = "rdb"

SOURCE_SUBTYPES = (SUBTYPE_BASE, SOURCE_SUBTYPE_RDB)

# --- Per-kind physical-name aliases (FR-016 / ADR-0018) --------------------
# One canonical attr key per rdb @kind. The single internal physical-name "slot"
# on the source is filled by whichever alias matches @kind; the canonical
# serializer emits the kind-matching alias regardless of which spelling was on
# input.
#: Physical SQL table name. Canonical attr for ``@kind: "table"`` (default).
SOURCE_ATTR_TABLE = "table"
#: Physical SQL view name. Canonical attr for ``@kind: "view"``.
SOURCE_ATTR_VIEW = "view"
#: Physical SQL materialized-view name. Canonical attr for ``@kind: "materializedView"``.
SOURCE_ATTR_MATERIALIZED_VIEW = "materializedView"
#: Physical SQL stored-procedure name. Canonical attr for ``@kind: "storedProc"``.
SOURCE_ATTR_PROC = "proc"
#: Physical SQL table-function name. Canonical attr for ``@kind: "tableFunction"``.
SOURCE_ATTR_FUNCTION = "function"

# --- Source attrs ----------------------------------------------------------
SOURCE_ATTR_KIND = "kind"
SOURCE_ATTR_ROLE = "role"
SOURCE_ATTR_SCHEMA = "schema"
# @parameterRef — name/FQN of an object.value describing the input shape of a
# stored-proc / table-function source. Cross-port (FR-015). Mirrors TS
# SOURCE_ATTR_PARAMETER_REF.
SOURCE_ATTR_PARAMETER_REF = "parameterRef"

# --- @kind values + read-only derivation ------------------------------------
SOURCE_KIND_TABLE = "table"
SOURCE_KIND_VIEW = "view"
SOURCE_KIND_MATERIALIZED_VIEW = "materializedView"
SOURCE_KIND_STORED_PROC = "storedProc"
SOURCE_KIND_TABLE_FUNCTION = "tableFunction"

SOURCE_RDB_KINDS = (
    SOURCE_KIND_TABLE,
    SOURCE_KIND_VIEW,
    SOURCE_KIND_MATERIALIZED_VIEW,
    SOURCE_KIND_STORED_PROC,
    SOURCE_KIND_TABLE_FUNCTION,
)

# @kind default when omitted (writable table).
DEFAULT_SOURCE_KIND = SOURCE_KIND_TABLE

# Kinds whose source is read-only (codegen emits read-only model/queries/routes).
SOURCE_READ_ONLY_KINDS = frozenset({
    SOURCE_KIND_VIEW,
    SOURCE_KIND_MATERIALIZED_VIEW,
    SOURCE_KIND_STORED_PROC,
    SOURCE_KIND_TABLE_FUNCTION,
})

# --- FR-016 / ADR-0018 — @kind → canonical physical-name attr key ----------
#: Drives the four-step physical-name resolution rule on :class:`MetaSource`
#: and the canonical-serializer per-kind rewrite. The single internal
#: physical-name "slot" on a source is the value of whichever alias matches
#: the source's @kind.
PHYSICAL_NAME_ATTR_BY_KIND: dict[str, str] = {
    SOURCE_KIND_TABLE:             SOURCE_ATTR_TABLE,
    SOURCE_KIND_VIEW:              SOURCE_ATTR_VIEW,
    SOURCE_KIND_MATERIALIZED_VIEW: SOURCE_ATTR_MATERIALIZED_VIEW,
    SOURCE_KIND_STORED_PROC:       SOURCE_ATTR_PROC,
    SOURCE_KIND_TABLE_FUNCTION:    SOURCE_ATTR_FUNCTION,
}

#: Every kind-aware physical-name alias key, ordered for deterministic
#: iteration (matches the SOURCE_RDB_KINDS order). Used by the validation pass
#: and by :meth:`MetaSource.physical_name`.
ALL_PHYSICAL_NAME_ALIASES: tuple[str, ...] = (
    SOURCE_ATTR_TABLE,
    SOURCE_ATTR_VIEW,
    SOURCE_ATTR_MATERIALIZED_VIEW,
    SOURCE_ATTR_PROC,
    SOURCE_ATTR_FUNCTION,
)

# --- @role values + default -------------------------------------------------
SOURCE_ROLE_PRIMARY = "primary"
SOURCE_ROLE_REPLICA = "replica"
SOURCE_ROLE_INDEX = "index"
SOURCE_ROLE_CACHE = "cache"
SOURCE_ROLE_PUBLISH = "publish"
SOURCE_ROLE_MIRROR = "mirror"

SOURCE_ROLES = (
    SOURCE_ROLE_PRIMARY,
    SOURCE_ROLE_REPLICA,
    SOURCE_ROLE_INDEX,
    SOURCE_ROLE_CACHE,
    SOURCE_ROLE_PUBLISH,
    SOURCE_ROLE_MIRROR,
)

# @role default when omitted (system of record).
DEFAULT_SOURCE_ROLE = SOURCE_ROLE_PRIMARY
