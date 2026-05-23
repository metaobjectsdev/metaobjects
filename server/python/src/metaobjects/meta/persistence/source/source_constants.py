"""Source subtype vocabulary (colocated)."""
from ....shared.base_types import SUBTYPE_BASE

SOURCE_SUBTYPE_DB_TABLE = "dbTable"
SOURCE_SUBTYPE_DB_VIEW = "dbView"
SOURCE_SUBTYPES = (SUBTYPE_BASE, SOURCE_SUBTYPE_DB_TABLE, SOURCE_SUBTYPE_DB_VIEW)

SOURCE_ATTR_NAME = "name"
SOURCE_ATTR_SCHEMA = "schema"
