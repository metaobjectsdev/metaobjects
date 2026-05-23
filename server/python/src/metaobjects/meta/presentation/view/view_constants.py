"""View subtype vocabulary (colocated)."""
from ....shared.base_types import SUBTYPE_BASE

VIEW_SUBTYPE_TEXT = "text"
VIEW_SUBTYPE_TEXTAREA = "textarea"
VIEW_SUBTYPE_DATE = "date"
VIEW_SUBTYPE_CURRENCY = "currency"
VIEW_SUBTYPES = (
    SUBTYPE_BASE,
    VIEW_SUBTYPE_TEXT,
    VIEW_SUBTYPE_TEXTAREA,
    VIEW_SUBTYPE_DATE,
    VIEW_SUBTYPE_CURRENCY,
)

# view.currency attrs
VIEW_ATTR_LOCALE = "locale"
