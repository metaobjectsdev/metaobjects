"""Lifecycle constants (ADR-0066): the ``transition`` type, its subtypes and attrs.

A lifecycle has no vocabulary of its own: it is a ``field.enum`` with at least one
``transition.action`` child. Mirrors TS ``core/transition/transition-constants.ts``.
"""
TRANSITION_SUBTYPE_ACTION = "action"
# RESERVED, not registered (ADR-0066): a move made by time.
TRANSITION_SUBTYPE_TIMED_RESERVED = "timed"
TRANSITION_SUBTYPES = (TRANSITION_SUBTYPE_ACTION,)

TRANSITION_ATTR_FROM = "from"
TRANSITION_ATTR_TO = "to"
TRANSITION_ATTR_CONDITION = "condition"
TRANSITION_ATTR_PERMISSION = "permission"
TRANSITION_ATTR_PUBLIC = "public"
