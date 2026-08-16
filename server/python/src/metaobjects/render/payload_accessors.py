"""Derived boolean accessors — ``{{#hasFoo}}`` over a payload field ``foo``.

A prompt needs conditional sections ("include the abilities block only when there ARE
abilities"), and the payload contract answers that with a DERIVED accessor rather than an
authored boolean field: the author declares ``abilities`` and ``hasAbilities`` follows
from it. Declaring both would let them disagree.

THE RULE IS SHARED ACROSS PORTS ON PURPOSE. The JVM has carried it since 7.7.7
(``com.metaobjects.render.PayloadAccessors``, emitted onto every generated payload record
and accepted by its ``Verify``), and its comment says the emitter and the verifier share
one rule so they "can never drift apart". Python had neither half, so the same template
verified clean on the JVM and reported drift here — and rendered WRONG rather than
failing, silently dropping the section. Gated cross-port by the
``render-derived-has-accessor`` conformance case.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

__all__ = [
    "HAS_PREFIX",
    "has_accessor_name",
    "capitalize",
    "accessor_value",
    "with_derived_accessors",
    "is_boolean_accessor",
]

#: The ``has`` prefix every derived boolean accessor carries.
HAS_PREFIX = "has"

_MAX_DEPTH = 32


def capitalize(s: str) -> str:
    """Capitalize the first character, leaving an already-uppercase one untouched.

    Deliberately NOT ``str.capitalize()``, which also lowercases the remainder.
    """
    if not s:
        return s
    if s[0].isupper():
        return s
    return s[0].upper() + s[1:]


def has_accessor_name(field_name: str) -> str:
    """``"has" + capitalize(name)`` (``abilities`` → ``hasAbilities``).

    Byte-identical to the JVM's ``PayloadAccessors.hasAccessorName``.
    """
    return HAS_PREFIX + capitalize(field_name)


def accessor_value(value: Any) -> bool | None:
    """Is ``value`` "present" for the purposes of ``has<Field>``?

    Mirrors the JVM emitter's per-type bodies exactly: string → non-null and non-blank;
    collection → non-null and non-empty; reference → non-null.

    Returns ``None`` for numbers and booleans, which the JVM deliberately emits NO
    accessor for — they are always-present scalars, and ``{{#hasCount}}`` over an int is
    drift rather than a conditional. Returning ``None`` (rather than ``False``) keeps that
    distinction: nothing is injected, so the name stays unresolved exactly as it is on a
    generated record with no such method.
    """
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    # bool before int — bool IS an int in Python, and a boolean field gets no accessor.
    if isinstance(value, (bool, int, float, complex)):
        return None
    if isinstance(value, Mapping):
        return True
    if isinstance(value, (Sequence, set, frozenset)):
        return len(value) > 0
    return True


def with_derived_accessors(payload: Any, depth: int = 0) -> Any:
    """A view over ``payload`` carrying its derived ``has<Field>`` accessors, recursively.

    NON-MUTATING — the caller's payload is never touched, because a render must not be
    able to change the object it was handed. An AUTHORED key always wins: if a payload
    genuinely carries ``hasFoo``, that value is kept rather than shadowed.

    Recursion follows Mustache's own scoping: every nested mapping and every sequence
    ELEMENT becomes a context in its own right, so a section over ``abilities`` sees the
    accessors of the ability it is currently iterating.
    """
    if depth > _MAX_DEPTH:
        return payload  # pathological graph; render is not a validator
    if isinstance(payload, Mapping):
        out: dict[str, Any] = {
            k: with_derived_accessors(v, depth + 1) for k, v in payload.items()
        }
        for k, v in payload.items():
            if not isinstance(k, str):
                continue
            name = has_accessor_name(k)
            if name in payload:  # authored wins
                continue
            derived = accessor_value(v)
            if derived is not None:
                out[name] = derived
        return out
    if isinstance(payload, (str, bytes)):
        return payload
    if isinstance(payload, Sequence):
        return [with_derived_accessors(v, depth + 1) for v in payload]
    return payload


def is_boolean_accessor(stack: list[list[Any]], name: str) -> bool:
    """True when ``name`` is a derived accessor over a field reachable on ``stack``.

    Mirrors the JVM's ``Verify.isBooleanAccessor``, including its deliberate
    permissiveness: acceptance keys off the FIELD EXISTING, not off its type. Accessors
    are simple (undotted) names; a dotted path is never an accessor.
    """
    if "." in name:
        return False
    if not name.startswith(HAS_PREFIX):
        return False
    # Mustache outward walk (innermost → outermost).
    for frame in reversed(stack):
        for f in frame:
            if name == has_accessor_name(f.name):
                return True
    return False
