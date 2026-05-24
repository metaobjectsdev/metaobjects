"""Source subtype vocabulary (colocated).

Source v2 (ADR-0007): paradigm subtype ``rdb`` with @table/@kind/@role/@schema attrs.
Read-only-ness is derived from @kind (view/materializedView/storedProc/tableFunction
are read-only; table — the default — is writable). Multiple sources per object are
allowed (write-through CQRS) but exactly one must have role == "primary".
"""
from ....shared.base_types import SUBTYPE_BASE

# --- Source v2 paradigm subtype --------------------------------------------
SOURCE_SUBTYPE_RDB = "rdb"

SOURCE_SUBTYPES = (SUBTYPE_BASE, SOURCE_SUBTYPE_RDB)

# --- Source attrs ----------------------------------------------------------
SOURCE_ATTR_TABLE = "table"
SOURCE_ATTR_KIND = "kind"
SOURCE_ATTR_ROLE = "role"
SOURCE_ATTR_SCHEMA = "schema"

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
