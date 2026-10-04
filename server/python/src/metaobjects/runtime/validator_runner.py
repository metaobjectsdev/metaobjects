"""Run-time validator runner — validate a data mapping against an entity's metadata.

The Python port of the TS ``runValidators``
(``server/typescript/packages/runtime-ts/src/validator-runner.ts``), which is the
contract: the same rules, the same failure structure, the same message text and the
same ordering. ``fixtures/validation-conformance/`` gates both runners, and its
``runtime-errors.json`` pins the exact failure list each must produce.

A pure function: it NEVER raises. Every failure across every field is collected; a
required or type failure stops further checks on that one value only.

Three places where Python would naturally differ from JavaScript are held to the JS
behaviour, because the failure list is byte-compared across the two runners:

- a ``bool`` is not a number (``isinstance(True, int)`` is true in Python);
- string length counts UTF-16 code units, as JS ``String.length`` does;
- a number in a message prints as JS prints it (``2.0`` is ``2``, ``1e-07`` is ``1e-7``).
"""
from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal

from ..meta.core.field import field_constants as fc
from ..meta.core.identity import identity_constants as ic
from ..meta.core.object.meta_object import MetaObject
from ..meta.core.object.object_constants import OBJECT_SUBTYPE_VALUE
from ..meta.core.validator import validator_constants as vc
from ..meta.meta_data import MetaData
from ..meta.persistence.db import db_constants as dbc
from ..shared.base_types import TYPE_FIELD, TYPE_VALIDATOR
from ..shared.separators import PACKAGE_SEP


@dataclass(frozen=True)
class ValidationFailure:
    """One failed rule. ``field`` is the field name, or ``name[i]`` for an array element
    and ``name.member`` / ``name[i].member`` inside a value object. ``expected`` and
    ``received`` are ``None`` when the rule reports none."""

    field: str
    rule: str
    message: str
    expected: object = None
    received: object = None

    def to_dict(self) -> dict[str, object]:
        """The wire shape — ``expected`` / ``received`` are omitted when absent, exactly
        as the TS runner omits them."""
        out: dict[str, object] = {"field": self.field, "rule": self.rule, "message": self.message}
        if self.expected is not None:
            out["expected"] = self.expected
        if self.received is not None:
            out["received"] = self.received
        return out


@dataclass(frozen=True)
class ValidationResult:
    """``ok`` is true exactly when ``errors`` is empty."""

    ok: bool
    errors: tuple[ValidationFailure, ...] = ()


# Fields that must arrive as a number.
_NUMERIC_FIELD_SUBTYPES = frozenset({fc.FIELD_SUBTYPE_INT, fc.FIELD_SUBTYPE_DOUBLE, fc.FIELD_SUBTYPE_FLOAT})
# 64-bit integer fields (BIGINT on the wire). The write contract also accepts a base-10
# integer string, so a full int64 survives a JSON transport that cannot carry one.
_INT64_FIELD_SUBTYPES = frozenset({fc.FIELD_SUBTYPE_LONG, fc.FIELD_SUBTYPE_CURRENCY})
_STRING_FIELD_SUBTYPES = frozenset({
    fc.FIELD_SUBTYPE_STRING, fc.FIELD_SUBTYPE_UUID, fc.FIELD_SUBTYPE_URI, fc.FIELD_SUBTYPE_INET,
})

# ASCII digits only — ``\d`` would also admit other Unicode digits, which JS ``\d`` does not.
_INT64_STRING_RE = re.compile(r"-?[0-9]+")

# The IPv4 and IPv6 literal patterns the TS runner uses (``runtime-ts/src/net-format.ts``),
# applied with ``fullmatch`` — a Python ``$`` would also match before a trailing newline.
_IPV4_RE = re.compile(
    r"(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}"
    r"(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])"
)
_IPV6_RE = re.compile(
    r"(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:"
    r"|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}"
    r"|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}"
    r"|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})"
    r"|:((:[0-9a-fA-F]{1,4}){1,7}|:)"
    r"|::(ffff(:0{1,4})?:)?((25[0-5]|(2[0-4]|1?[0-9])?[0-9])\.){3}(25[0-5]|(2[0-4]|1?[0-9])?[0-9])"
    r"|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1?[0-9])?[0-9])\.){3}(25[0-5]|(2[0-4]|1?[0-9])?[0-9]))"
)

# Leading/trailing C0 controls and spaces, which a URL parser strips before parsing.
_URI_PAD = "".join(chr(c) for c in range(0x21))
_URI_SCHEME_RE = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*:(.*)", re.DOTALL)
_URI_AUTHORITY_END_RE = re.compile(r"[/?#]")


def run_validators(
    entity: MetaData,
    data: Mapping[str, object],
    *,
    partial: bool = False,
    store_filled: Sequence[str] = (),
) -> ValidationResult:
    """Validate ``data`` against ``entity``'s fields and their validators.

    ``partial`` is update mode: a required check fires only for a key present in ``data``.
    ``store_filled`` names fields the store fills on insert (a driver-generated primary
    key) — exempt from required when ABSENT; a present ``None`` is still a failure.
    """
    errors: list[ValidationFailure] = []
    assigned_pk = _assigned_pk_field_names(entity)

    # ADR-0039: effective children, so a subtype validates inherited base fields too.
    for field in entity.children():
        if field.type != TYPE_FIELD:
            continue
        name = field.name
        present = name in data
        value = data.get(name)

        required = _is_required(field)
        # An ASSIGNED primary key must be supplied whatever @required says: nothing else
        # can produce the value. Presence only — the non-empty-string floor stays tied to
        # a DECLARED required.
        if (required or name in assigned_pk) and value is None:
            if partial and not present:
                continue
            # A @default (ADR-0039: resolving) exempts an ABSENT field only — the store
            # fills it. An explicit null is a deliberate clear the default cannot cover.
            if not present and field.get_meta_attr(fc.FIELD_ATTR_DEFAULT) is not None:
                continue
            if not present and name in store_filled:
                continue
            errors.append(ValidationFailure(name, "required", f"'{name}' is required"))
            continue

        if value is None:
            continue

        # Open-bag jsonb column: holds ANY JSON value, so no string checks apply.
        # ADR-0039 sanctioned own: @dbColumnType is the one deliberately own-only attr
        # (physical, never inherited).
        if (
            field.sub_type == fc.FIELD_SUBTYPE_STRING
            and field.attr(dbc.FIELD_ATTR_DB_COLUMN_TYPE) == dbc.DB_COLUMN_TYPE_JSONB
        ):
            continue

        is_array = field.resolved_is_array()

        if field.sub_type == fc.FIELD_SUBTYPE_OBJECT:
            vo = _resolve_vo_ref(field)
            if vo is not None:
                errors.extend(_value_object_errors(field, vo, value, is_array))
            continue

        if is_array:
            if not _is_js_array(value):
                errors.append(ValidationFailure(
                    name, "type", f"'{name}' must be an array", "array", _js_typeof(value),
                ))
                continue
            elements = list(value)  # type: ignore[call-overload]
            errors.extend(_array_size_errors(field, len(elements)))
            for i, el in enumerate(elements):
                if el is not None:
                    errors.extend(_scalar_errors(field, el, False, f"{name}[{i}]"))
            continue

        errors.extend(_scalar_errors(field, value, required, name))

    return ValidationResult(ok=not errors, errors=tuple(errors))


def _value_object_errors(
    field: MetaData, vo: MetaObject, value: object, is_array: bool,
) -> list[ValidationFailure]:
    """A present value object is validated in FULL (never partial), single or array."""
    name = field.name
    if is_array and not _is_js_array(value):
        return [ValidationFailure(
            name, "type", f"'{name}' must be an array of {vo.name}", "array", _js_typeof(value),
        )]
    elements = list(value) if is_array else [value]  # type: ignore[call-overload]
    errors: list[ValidationFailure] = []
    if is_array:
        errors.extend(_array_size_errors(field, len(elements)))
    for i, el in enumerate(elements):
        if not isinstance(el, Mapping):
            errors.append(ValidationFailure(
                name, "type", f"'{name}' must be a {vo.name} object", vo.name,
                "null" if el is None else _js_typeof(el),
            ))
            continue
        prefix = f"{name}[{i}]" if is_array else name
        for e in run_validators(vo, el).errors:
            errors.append(ValidationFailure(f"{prefix}.{e.field}", e.rule, e.message, e.expected, e.received))
    return errors


def _resolve_vo_ref(field: MetaData) -> MetaObject | None:
    """The ``object.value`` a ``field.object``'s ``@objectRef`` names, found by walking to
    the tree root. ``None`` when unresolvable or when the target is not a value object —
    then there is no recursion, on every port."""
    # ADR-0039: resolving — @objectRef may be inherited via extends.
    ref = field.get_meta_attr(fc.FIELD_ATTR_OBJECT_REF)
    if not isinstance(ref, str) or not ref:
        return None
    root: MetaData = field
    while root.parent is not None:
        root = root.parent
    objects = [c for c in root.children() if isinstance(c, MetaObject)]
    short = ref.rsplit(PACKAGE_SEP, 1)[-1]
    target = next((o for o in objects if o.resolution_key() == ref), None) or next(
        (o for o in objects if o.name == short), None,
    )
    return target if target is not None and target.sub_type == OBJECT_SUBTYPE_VALUE else None


def _assigned_pk_field_names(entity: MetaData) -> frozenset[str]:
    """Primary-identity field names the CALLER must supply: the identity carries no
    store-side ``@generation`` (increment / uuid)."""
    primary = entity.primary_identity() if isinstance(entity, MetaObject) else None
    if primary is None:
        return frozenset()
    # ADR-0039: resolving — an identity's attrs may be inherited via extends.
    if primary.get_meta_attr(ic.IDENTITY_ATTR_GENERATION) in (ic.GENERATION_INCREMENT, ic.GENERATION_UUID):
        return frozenset()
    fields = primary.get_meta_attr(ic.IDENTITY_ATTR_FIELDS)
    if isinstance(fields, str):
        return frozenset({fields})
    if isinstance(fields, (list, tuple)):
        return frozenset(str(f) for f in fields)
    return frozenset()


def _validators(field: MetaData, sub_type: str) -> list[MetaData]:
    # ADR-0039: effective children — a validator may be inherited via extends.
    return [c for c in field.children() if c.type == TYPE_VALIDATOR and c.sub_type == sub_type]


def _is_required(field: MetaData) -> bool:
    # ADR-0039: resolving — @required may be inherited via extends.
    if field.get_meta_attr(fc.FIELD_ATTR_REQUIRED) is True:
        return True
    return bool(_validators(field, vc.VALIDATOR_SUBTYPE_REQUIRED))


def _number(value: object) -> int | float | None:
    """``value`` when it is a JS ``number`` — an int or float, never a bool."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value


def _validator_bounds(field: MetaData, sub_type: str) -> tuple[int | float | None, int | float | None]:
    """The ``(@min, @max)`` of the field's validators of one subtype (last authored wins)."""
    lo: int | float | None = None
    hi: int | float | None = None
    for child in _validators(field, sub_type):
        # ADR-0039: resolving — a validator's bounds may be inherited via extends.
        child_min = _number(child.get_meta_attr(vc.VALIDATOR_ATTR_MIN))
        child_max = _number(child.get_meta_attr(vc.VALIDATOR_ATTR_MAX))
        lo = child_min if child_min is not None else lo
        hi = child_max if child_max is not None else hi
    return lo, hi


def _length_bounds(field: MetaData) -> tuple[int | float | None, int | float | None]:
    """String length ``(min, max)``. Max is strictest-wins across ``@maxLength`` and every
    ``validator.length @max``. Min is the authored ``validator.length @min``, ``None`` when
    none was authored."""
    lo: int | float | None = None
    # ADR-0039: resolving — @maxLength may be inherited via extends.
    hi = _number(field.get_meta_attr(fc.FIELD_ATTR_MAX_LENGTH))
    for child in _validators(field, vc.VALIDATOR_SUBTYPE_LENGTH):
        child_min = _number(child.get_meta_attr(vc.VALIDATOR_ATTR_MIN))
        child_max = _number(child.get_meta_attr(vc.VALIDATOR_ATTR_MAX))
        lo = child_min if child_min is not None else lo
        if child_max is not None:
            hi = child_max if hi is None else min(hi, child_max)
    return lo, hi


def _array_size_errors(field: MetaData, size: int) -> list[ValidationFailure]:
    """``validator.array @min/@max`` — element-count bounds on an array field."""
    name = field.name
    lo, hi = _validator_bounds(field, vc.VALIDATOR_SUBTYPE_ARRAY)
    errors: list[ValidationFailure] = []
    if lo is not None and size < lo:
        errors.append(ValidationFailure(
            name, "array", f"'{name}' must have at least {_js_number(lo)} items (got {size})", {"min": lo}, size,
        ))
    if hi is not None and size > hi:
        errors.append(ValidationFailure(
            name, "array", f"'{name}' must have at most {_js_number(hi)} items (got {size})", {"max": hi}, size,
        ))
    return errors


def _check_type(sub_type: str, value: object) -> str | None:
    if sub_type in _STRING_FIELD_SUBTYPES:
        if not isinstance(value, str):
            return "expected string"
    elif sub_type in _NUMERIC_FIELD_SUBTYPES:
        if _number(value) is None:
            return "expected number"
    elif sub_type in _INT64_FIELD_SUBTYPES:
        if _number(value) is not None:
            return None
        if isinstance(value, str) and _INT64_STRING_RE.fullmatch(value):
            return None
        return "expected a 64-bit integer (number, bigint, or numeric string)"
    elif sub_type == fc.FIELD_SUBTYPE_BOOLEAN:
        if not isinstance(value, bool):
            return "expected boolean"
    return None


def _scalar_errors(field: MetaData, value: object, required: bool, label: str) -> list[ValidationFailure]:
    """The type, length, regex, numeric and format failures for one scalar value — the
    whole field value, or one element of a scalar array (then ``required`` is false and
    ``label`` is ``name[i]``)."""
    type_error = _check_type(field.sub_type, value)
    if type_error is not None:
        return [ValidationFailure(label, "type", type_error, field.sub_type, _js_typeof(value))]

    errors: list[ValidationFailure] = []
    if isinstance(value, str):
        length = _utf16_length(value)
        min_len, max_len = _length_bounds(field)
        if max_len is not None and length > max_len:
            errors.append(ValidationFailure(
                label, "length", f"'{label}' must be at most {_js_number(max_len)} chars (got {length})",
                {"max": max_len}, length,
            ))
        # A @required string is non-empty by default (a floor of 1), but an authored
        # validator.length @min is ALWAYS authoritative over that floor: @min 0 opts out.
        effective_min = min_len if min_len is not None else (1 if required else 0)
        if effective_min > 0 and length < effective_min:
            errors.append(ValidationFailure(
                label, "length", f"'{label}' must be at least {_js_number(effective_min)} chars (got {length})",
                {"min": effective_min}, length,
            ))

        for child in _validators(field, vc.VALIDATOR_SUBTYPE_REGEX):
            # ADR-0039: resolving — @pattern may be inherited via extends.
            pattern = child.get_meta_attr(vc.VALIDATOR_ATTR_PATTERN)
            if not isinstance(pattern, str):
                continue
            try:
                # @pattern is FULL-MATCH: the whole value must match.
                matched = re.fullmatch(f"(?:{pattern})", value) is not None
            except re.error:
                errors.append(ValidationFailure(
                    label, "regex", f"'{label}' has an invalid validator pattern: {pattern}", pattern,
                ))
                continue
            if not matched:
                errors.append(ValidationFailure(
                    label, "regex", f"'{label}' does not match required pattern", pattern, value,
                ))

    # validator.numeric @min/@max — inclusive value bounds on a numeric field.
    if field.sub_type in _NUMERIC_FIELD_SUBTYPES or field.sub_type in _INT64_FIELD_SUBTYPES:
        # The type check passed, so a string here is a base-10 int64 literal.
        num = int(value) if isinstance(value, str) else _number(value)
        lo, hi = _validator_bounds(field, vc.VALIDATOR_SUBTYPE_NUMERIC)
        if num is not None and lo is not None and num < lo:
            errors.append(ValidationFailure(
                label, "numeric", f"'{label}' must be at least {_js_number(lo)} (got {_js_number(value)})",
                {"min": lo}, value,
            ))
        if num is not None and hi is not None and num > hi:
            errors.append(ValidationFailure(
                label, "numeric", f"'{label}' must be at most {_js_number(hi)} (got {_js_number(value)})",
                {"max": hi}, value,
            ))

    # field.uri / field.inet — the strict format contract, unless @lenient opts out.
    # ADR-0039: resolving — @lenient may be inherited via extends.
    if isinstance(value, str) and field.get_meta_attr(fc.FIELD_ATTR_LENIENT) is not True:
        if field.sub_type == fc.FIELD_SUBTYPE_URI and not _is_absolute_uri(value):
            errors.append(ValidationFailure(label, "format", f"'{label}' must be an absolute URI", "uri", value))
        if field.sub_type == fc.FIELD_SUBTYPE_INET and not _is_inet_literal(value):
            errors.append(ValidationFailure(
                label, "format", f"'{label}' must be an IPv4 or IPv6 address", "inet", value,
            ))
    return errors


def _is_inet_literal(value: str) -> bool:
    return _IPV4_RE.fullmatch(value) is not None or _IPV6_RE.fullmatch(value) is not None


def _is_absolute_uri(value: str) -> bool:
    """A scheme, a non-empty remainder and — when the remainder opens an authority with
    ``//`` — a non-empty authority. Padding is stripped first."""
    match = _URI_SCHEME_RE.fullmatch(value.strip(_URI_PAD))
    if match is None or not match.group(1):
        return False
    rest = match.group(1)
    if not rest.startswith("//"):
        return True
    return bool(_URI_AUTHORITY_END_RE.split(rest[2:], maxsplit=1)[0])


def _is_js_array(value: object) -> bool:
    return isinstance(value, (list, tuple))


def _js_typeof(value: object) -> str:
    """The JS ``typeof`` name a failure's ``received`` carries, so it matches the TS runner."""
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    return "object"


def _utf16_length(value: str) -> int:
    """JS ``String.length`` — UTF-16 code units, so a non-BMP character counts as 2."""
    return len(value.encode("utf-16-le", "surrogatepass")) // 2


def _js_number(value: object) -> str:
    """``value`` as a JS template literal prints it (ECMAScript ``Number::toString``).

    Python and JS agree on the shortest round-trip DIGITS of a float but lay them out
    differently: JS prints an integral float with no ``.0``, switches to exponent notation
    only below 1e-6 and from 1e21, writes the exponent unpadded (``1e-7``, ``1e+21``), and
    names the non-finite values ``Infinity`` / ``NaN``. An ``int`` and a string print as
    they are."""
    if not isinstance(value, float):
        return str(value)
    if value != value:
        return "NaN"
    if value in (float("inf"), float("-inf")):
        return "Infinity" if value > 0 else "-Infinity"
    if value == 0:
        return "0"
    sign, digit_tuple, exponent = Decimal(repr(abs(value))).as_tuple()
    digits = "".join(map(str, digit_tuple)).rstrip("0")
    # The decimal point sits after ``point`` digits: value = 0.<digits> x 10^point.
    point = len(digit_tuple) + int(exponent)
    count = len(digits)
    if count <= point <= 21:
        text = digits + "0" * (point - count)
    elif 0 < point <= 21:
        text = f"{digits[:point]}.{digits[point:]}"
    elif -6 < point <= 0:
        text = "0." + "0" * -point + digits
    else:
        mantissa = digits if count == 1 else f"{digits[0]}.{digits[1:]}"
        text = f"{mantissa}e{'+' if point > 0 else '-'}{abs(point - 1)}"
    return text if value > 0 else f"-{text}"
