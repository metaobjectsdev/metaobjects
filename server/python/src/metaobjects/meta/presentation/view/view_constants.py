"""View subtype vocabulary (colocated).

The view's subType IS the UI control type.

SP-G Phase1 Unit3 (B-2): the 11 generic web-presentation control kinds
(text/textarea/date/month/hotlink/dropdown/radio/checkbox/number/password/
hidden/web) are TS-web-presentation-only — they have NO backend / codegen /
render consumer in Python, so they are dead vocab here and were DEREGISTERED.
They remain registered in TypeScript (the web client + TS form codegen require
them for authoring). Only ``base`` + ``currency`` (the cross-port currency
``@locale`` wire contract) are registered cross-port.
"""
from ....shared.base_types import SUBTYPE_BASE

VIEW_SUBTYPE_CURRENCY = "currency"
VIEW_SUBTYPES = (
    SUBTYPE_BASE,
    VIEW_SUBTYPE_CURRENCY,
)

# view.currency attrs — @locale (BCP 47). Only on view.currency; defaults to "en-US".
VIEW_ATTR_LOCALE = "locale"
