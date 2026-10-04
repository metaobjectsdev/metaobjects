"""View subtype vocabulary (colocated).

The view's subType IS the UI control type.

Every port REGISTERS the full view vocabulary, so one metadata document loads
in every port. The generic web-presentation control kinds (text/textarea/date/
month/hotlink/dropdown/radio/checkbox/number/password/hidden/web/image) are
still TS-web-PRESENTATION-ONLY: they have no backend / codegen / render consumer
in Python, and the registry manifest excludes them (``registry_manifest``,
PRESENTATION_ONLY). Registration here is for LOADING only. ``base`` +
``currency`` (the cross-port currency ``@locale`` wire contract) are the two
rows in the cross-port manifest.

Mirrors typescript/packages/metadata/src/presentation/view/view-constants.ts.
"""
from ....shared.base_types import SUBTYPE_BASE

VIEW_SUBTYPE_TEXT = "text"
VIEW_SUBTYPE_TEXTAREA = "textarea"
VIEW_SUBTYPE_DATE = "date"
VIEW_SUBTYPE_MONTH = "month"
VIEW_SUBTYPE_HOTLINK = "hotlink"
VIEW_SUBTYPE_DROPDOWN = "dropdown"
VIEW_SUBTYPE_RADIO = "radio"
VIEW_SUBTYPE_CHECKBOX = "checkbox"
VIEW_SUBTYPE_NUMBER = "number"
VIEW_SUBTYPE_PASSWORD = "password"
VIEW_SUBTYPE_HIDDEN = "hidden"
VIEW_SUBTYPE_WEB = "web"
VIEW_SUBTYPE_CURRENCY = "currency"
VIEW_SUBTYPE_IMAGE = "image"
VIEW_SUBTYPES = (
    SUBTYPE_BASE,
    VIEW_SUBTYPE_TEXT,
    VIEW_SUBTYPE_TEXTAREA,
    VIEW_SUBTYPE_DATE,
    VIEW_SUBTYPE_MONTH,
    VIEW_SUBTYPE_HOTLINK,
    VIEW_SUBTYPE_DROPDOWN,
    VIEW_SUBTYPE_RADIO,
    VIEW_SUBTYPE_CHECKBOX,
    VIEW_SUBTYPE_NUMBER,
    VIEW_SUBTYPE_PASSWORD,
    VIEW_SUBTYPE_HIDDEN,
    VIEW_SUBTYPE_WEB,
    VIEW_SUBTYPE_CURRENCY,
    VIEW_SUBTYPE_IMAGE,
)

# view.currency attrs — @locale (BCP 47). Only on view.currency; defaults to "en-US".
VIEW_ATTR_LOCALE = "locale"
