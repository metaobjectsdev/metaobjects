"""``run_validators`` — the Python port of the TS ``runValidators`` run-time runner.

Mirrors ``server/typescript/packages/runtime-ts/test/validator-runner.test.ts`` case for
case: the same rules, the same failure structure and the same message text.
"""
from __future__ import annotations

import json

import metaobjects.core_types  # noqa: F401  — side effect: registers core types
from metaobjects import MetaDataLoader
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.runtime import ValidationFailure, ValidationResult, run_validators


def _load(*children: dict, name: str = "Post", extra: tuple[dict, ...] = ()) -> MetaObject:
    doc = {"metadata.root": {"package": "p", "children": [
        {"object.entity": {"name": name, "children": list(children)}}, *extra,
    ]}}
    result = MetaDataLoader.from_string(json.dumps(doc))
    assert not result.errors, [str(e) for e in result.errors]
    return next(c for c in result.root.children() if isinstance(c, MetaObject) and c.name == name)


def _errors(entity: MetaObject, data: dict, **opts: object) -> list[dict]:
    return [e.to_dict() for e in run_validators(entity, data, **opts).errors]  # type: ignore[arg-type]


def _rules(entity: MetaObject, data: dict, **opts: object) -> list[str]:
    return [f"{e['field']}:{e['rule']}" for e in _errors(entity, data, **opts)]


def _string(name: str, **attrs: object) -> dict:
    return {"field.string": {"name": name, **{f"@{k}": v for k, v in attrs.items()}}}


def _with(field: dict, *validators: dict) -> dict:
    next(iter(field.values()))["children"] = list(validators)
    return field


# ── result shape ─────────────────────────────────────────────────────────────


def test_ok_result_has_no_errors() -> None:
    result = run_validators(_load(_string("title")), {"title": "x"})
    assert result == ValidationResult(ok=True, errors=())


def test_failure_to_dict_omits_absent_expected_and_received() -> None:
    failure = ValidationFailure(field="title", rule="required", message="'title' is required")
    assert failure.to_dict() == {"field": "title", "rule": "required", "message": "'title' is required"}


# ── required ─────────────────────────────────────────────────────────────────


def test_validator_required_missing_field() -> None:
    e = _load(_with(_string("title"), {"validator.required": {}}))
    assert _errors(e, {}) == [{"field": "title", "rule": "required", "message": "'title' is required"}]


def test_required_attr_shortcut() -> None:
    e = _load(_string("title", required=True))
    assert _rules(e, {}) == ["title:required"]
    assert _rules(e, {"title": None}) == ["title:required"]
    assert _rules(e, {"title": "hello"}) == []


def test_required_string_rejects_empty_but_accepts_whitespace() -> None:
    e = _load(_string("title", required=True))
    assert _errors(e, {"title": ""}) == [{
        "field": "title", "rule": "length", "message": "'title' must be at least 1 chars (got 0)",
        "expected": {"min": 1}, "received": 0,
    }]
    assert _rules(e, {"title": "   "}) == []


def test_partial_mode_skips_absent_required_but_rejects_present_null() -> None:
    e = _load(_string("title", required=True))
    assert _rules(e, {}, partial=True) == []
    assert _rules(e, {"title": None}, partial=True) == ["title:required"]


def test_default_exempts_an_absent_required_field_only() -> None:
    e = _load(_string("status", required=True, default="new"))
    assert _rules(e, {}) == []
    assert _rules(e, {"status": None}) == ["status:required"]


def test_store_filled_exempts_an_absent_field_only() -> None:
    e = _load(_string("id", required=True))
    assert _rules(e, {}, store_filled=["id"]) == []
    assert _rules(e, {"id": None}, store_filled=["id"]) == ["id:required"]


# ── length ───────────────────────────────────────────────────────────────────


def test_length_max_and_min() -> None:
    e = _load(_with(_string("title"), {"validator.length": {"@min": 3, "@max": 5}}))
    assert _errors(e, {"title": "toolong"}) == [{
        "field": "title", "rule": "length", "message": "'title' must be at most 5 chars (got 7)",
        "expected": {"max": 5}, "received": 7,
    }]
    assert _errors(e, {"title": "ab"}) == [{
        "field": "title", "rule": "length", "message": "'title' must be at least 3 chars (got 2)",
        "expected": {"min": 3}, "received": 2,
    }]


def test_max_length_and_validator_max_is_strictest_wins() -> None:
    e = _load(_with(_string("label", maxLength=8), {"validator.length": {"@max": 4}}))
    assert _rules(e, {"label": "1234"}) == []
    assert _errors(e, {"label": "12345"})[0]["expected"] == {"max": 4}


def test_authored_min_zero_opts_out_of_the_required_floor() -> None:
    e = _load(_with(_string("note", required=True), {"validator.length": {"@min": 0}}))
    assert _rules(e, {"note": ""}) == []
    assert _rules(e, {}) == ["note:required"]


def test_length_counts_utf16_code_units() -> None:
    e = _load(_string("icon", maxLength=1))
    assert _errors(e, {"icon": "\U0001F600"})[0]["received"] == 2


# ── regex ────────────────────────────────────────────────────────────────────


def test_regex_is_full_match() -> None:
    e = _load(_with(_string("code"), {"validator.regex": {"@pattern": "[A-Z]+"}}))
    assert _rules(e, {"code": "ABC"}) == []
    assert _errors(e, {"code": "xxABCyy"}) == [{
        "field": "code", "rule": "regex", "message": "'code' does not match required pattern",
        "expected": "[A-Z]+", "received": "xxABCyy",
    }]


def test_regex_rejects_a_trailing_newline() -> None:
    e = _load(_with(_string("code"), {"validator.regex": {"@pattern": "[A-Z]+"}}))
    assert _rules(e, {"code": "ABC\n"}) == ["code:regex"]


def test_invalid_pattern_is_a_structured_error_never_an_exception() -> None:
    e = _load(_with(_string("code"), {"validator.regex": {"@pattern": "("}}))
    assert _errors(e, {"code": "x"}) == [{
        "field": "code", "rule": "regex",
        "message": "'code' has an invalid validator pattern: (", "expected": "(",
    }]


# ── type checks ──────────────────────────────────────────────────────────────


def test_type_failures_use_the_ts_messages_and_typeof_names() -> None:
    e = _load(
        {"field.int": {"name": "count"}}, {"field.boolean": {"name": "live"}}, _string("title"),
        {"field.double": {"name": "ratio"}},
    )
    assert _errors(e, {"count": "x", "live": 1, "title": 5, "ratio": "1.5"}) == [
        {"field": "count", "rule": "type", "message": "expected number", "expected": "int", "received": "string"},
        {"field": "live", "rule": "type", "message": "expected boolean", "expected": "boolean", "received": "number"},
        {"field": "title", "rule": "type", "message": "expected string", "expected": "string", "received": "number"},
        {"field": "ratio", "rule": "type", "message": "expected number", "expected": "double", "received": "string"},
    ]


def test_a_bool_is_not_a_number() -> None:
    e = _load({"field.int": {"name": "count"}}, {"field.long": {"name": "total"}})
    assert _errors(e, {"count": True, "total": False}) == [
        {"field": "count", "rule": "type", "message": "expected number", "expected": "int", "received": "boolean"},
        {"field": "total", "rule": "type",
         "message": "expected a 64-bit integer (number, bigint, or numeric string)",
         "expected": "long", "received": "boolean"},
    ]


def test_null_skips_the_type_check() -> None:
    assert _rules(_load({"field.int": {"name": "count"}}), {"count": None}) == []


def test_int64_fields_accept_a_number_or_an_integer_string() -> None:
    e = _load({"field.long": {"name": "total"}}, {"field.currency": {"name": "price"}})
    assert _rules(e, {"total": "9223372036854775807", "price": "-12"}) == []
    assert _rules(e, {"total": 9223372036854775807, "price": 12}) == []
    assert _rules(e, {"total": "1.5"}) == ["total:type"]
    assert _rules(e, {"price": "１２"}) == ["price:type"]  # non-ASCII digits are not an int64 literal


def test_type_failure_stops_further_checks_on_that_value() -> None:
    e = _load(_with(_string("code", maxLength=1), {"validator.regex": {"@pattern": "[A-Z]+"}}))
    assert _rules(e, {"code": 12}) == ["code:type"]


def test_collects_all_failures_across_fields() -> None:
    e = _load(_string("title", required=True), _string("slug", maxLength=3), {"field.int": {"name": "n"}})
    assert _rules(e, {"slug": "toolong", "n": "x"}) == ["title:required", "slug:length", "n:type"]


def test_open_bag_jsonb_string_holds_any_json_value() -> None:
    e = _load(_string("bag", dbColumnType="jsonb", maxLength=2))
    assert _rules(e, {"bag": {"a": [1, 2, 3]}}) == []


# ── arrays ───────────────────────────────────────────────────────────────────


def _tags(**validator: object) -> MetaObject:
    field = {"field.string": {"name": "tags", "isArray": True, "@maxLength": 3}}
    if validator:
        _with(field, {"validator.array": {f"@{k}": v for k, v in validator.items()}})
    return _load(field, {"field.int": {"name": "scores", "isArray": True}})


def test_scalar_array_of_valid_elements_passes() -> None:
    assert _rules(_tags(), {"tags": ["a", "bc"], "scores": [1, 2]}) == []


def test_scalar_array_non_array_value_is_a_type_error() -> None:
    assert _errors(_tags(), {"tags": "a"}) == [{
        "field": "tags", "rule": "type", "message": "'tags' must be an array",
        "expected": "array", "received": "string",
    }]


def test_scalar_array_element_error_names_its_index() -> None:
    assert _rules(_tags(), {"tags": ["ok", "toolong"], "scores": [1, "x"]}) == ["tags[1]:length", "scores[1]:type"]


def test_array_size_bounds() -> None:
    e = _tags(min=1, max=3)
    assert _errors(e, {"tags": []}) == [{
        "field": "tags", "rule": "array", "message": "'tags' must have at least 1 items (got 0)",
        "expected": {"min": 1}, "received": 0,
    }]
    assert _errors(e, {"tags": ["a", "b", "c", "d"]}) == [{
        "field": "tags", "rule": "array", "message": "'tags' must have at most 3 items (got 4)",
        "expected": {"max": 3}, "received": 4,
    }]


def test_element_errors_are_reported_alongside_a_size_failure() -> None:
    assert _rules(_tags(min=1, max=3), {"tags": ["a", "b", "c", 4]}) == ["tags:array", "tags[3]:type"]


def test_validator_array_on_a_non_array_field_is_ignored() -> None:
    e = _load(_with(_string("name"), {"validator.array": {"@min": 2}}))
    assert _rules(e, {"name": "x"}) == []


# ── numeric ──────────────────────────────────────────────────────────────────


def _score() -> MetaObject:
    return _load({"field.int": {"name": "score", "children": [{"validator.numeric": {"@min": 0, "@max": 100}}]}})


def test_numeric_bounds_are_inclusive() -> None:
    assert _rules(_score(), {"score": 0}) == []
    assert _rules(_score(), {"score": 100}) == []


def test_numeric_below_min_and_above_max() -> None:
    assert _errors(_score(), {"score": -1}) == [{
        "field": "score", "rule": "numeric", "message": "'score' must be at least 0 (got -1)",
        "expected": {"min": 0}, "received": -1,
    }]
    assert _errors(_score(), {"score": 101}) == [{
        "field": "score", "rule": "numeric", "message": "'score' must be at most 100 (got 101)",
        "expected": {"max": 100}, "received": 101,
    }]


def test_numeric_int64_string_is_compared_as_an_integer_and_echoed_as_given() -> None:
    e = _load({"field.long": {"name": "total", "children": [{"validator.numeric": {"@min": 10}}]}})
    assert _rules(e, {"total": "9223372036854775807"}) == []
    assert _errors(e, {"total": "5"}) == [{
        "field": "total", "rule": "numeric", "message": "'total' must be at least 10 (got 5)",
        "expected": {"min": 10}, "received": "5",
    }]


def test_numeric_message_prints_an_integral_float_as_javascript_does() -> None:
    e = _load({"field.double": {"name": "ratio", "children": [{"validator.numeric": {"@max": 1}}]}})
    assert _errors(e, {"ratio": 2.0})[0]["message"] == "'ratio' must be at most 1 (got 2)"
    assert _errors(e, {"ratio": 1.5})[0]["message"] == "'ratio' must be at most 1 (got 1.5)"


def test_validator_numeric_on_a_string_field_is_ignored() -> None:
    e = _load(_with(_string("code"), {"validator.numeric": {"@min": 5}}))
    assert _rules(e, {"code": "1"}) == []


# ── field.uri / field.inet ───────────────────────────────────────────────────


def _net() -> MetaObject:
    return _load(
        {"field.uri": {"name": "website"}}, {"field.inet": {"name": "sourceIp"}},
        {"field.uri": {"name": "citationUrl", "@lenient": True}},
        {"field.inet": {"name": "reportedIp", "@lenient": True}},
    )


def test_strict_uri_accepts_an_absolute_uri_padded_or_not() -> None:
    for website in ["https://a.com", "  https://a.com  ", "mailto:a@b.com", "urn:isbn:0451450523"]:
        assert _rules(_net(), {"website": website}) == []


def test_strict_uri_rejects_schemeless_empty_authority_and_bare_scheme() -> None:
    for website in ["example.com", "/path/only", "not a url", "http://", "http:", ""]:
        assert _errors(_net(), {"website": website}) == [{
            "field": "website", "rule": "format", "message": "'website' must be an absolute URI",
            "expected": "uri", "received": website,
        }]


def test_strict_inet_accepts_ip_literals_only() -> None:
    for ip in ["192.168.0.1", "::1", "2001:db8::1", "::ffff:1.2.3.4"]:
        assert _rules(_net(), {"sourceIp": ip}) == []
    assert _errors(_net(), {"sourceIp": "192.168.01.1"}) == [{
        "field": "sourceIp", "rule": "format", "message": "'sourceIp' must be an IPv4 or IPv6 address",
        "expected": "inet", "received": "192.168.01.1",
    }]
    assert _rules(_net(), {"sourceIp": "192.168.0.1\n"}) == ["sourceIp:format"]


def test_lenient_accepts_any_string() -> None:
    assert _rules(_net(), {"citationUrl": "not a url", "reportedIp": "example.com"}) == []


def test_non_string_uri_or_inet_is_a_type_failure_lenient_or_not() -> None:
    assert _rules(_net(), {"website": 5, "reportedIp": 5}) == ["website:type", "reportedIp:type"]


# ── assigned primary key ─────────────────────────────────────────────────────


def _ledger(generation: str | None = None, **code_attrs: object) -> MetaObject:
    pk: dict = {"name": "pk", "@fields": "code"}
    if generation is not None:
        pk["@generation"] = generation
    return _load(_string("code", **code_attrs), _string("label"), {"identity.primary": pk}, name="Ledger")


def test_assigned_pk_is_required_whatever_required_says() -> None:
    assert _errors(_ledger(), {"label": "x"}) == [{"field": "code", "rule": "required", "message": "'code' is required"}]
    assert _rules(_ledger(), {"code": "L-1"}) == []


def test_generated_pk_is_not_demanded() -> None:
    assert _rules(_ledger("increment"), {}) == []
    assert _rules(_ledger("uuid"), {}) == []


def test_pk_with_a_default_may_be_omitted() -> None:
    assert _rules(_ledger(default="L-0"), {}) == []


def test_partial_mode_leaves_an_absent_pk_alone_but_rejects_a_present_null() -> None:
    assert _rules(_ledger(), {}, partial=True) == []
    assert _rules(_ledger(), {"code": None}, partial=True) == ["code:required"]


def test_assigned_pk_is_presence_only() -> None:
    assert _rules(_ledger(), {"code": ""}) == []


# ── value objects ────────────────────────────────────────────────────────────


def _with_address(is_array: bool = False) -> MetaObject:
    address = {"object.value": {"name": "Address", "children": [
        _string("city", required=True), _string("zip", maxLength=5),
    ]}}
    field: dict = {"field.object": {"name": "address", "@objectRef": "Address"}}
    if is_array:
        field["field.object"]["isArray"] = True
    return _load(field, name="Person", extra=(address,))


def test_value_object_members_are_validated_with_a_dotted_label() -> None:
    assert _errors(_with_address(), {"address": {"zip": "123456"}}) == [
        {"field": "address.city", "rule": "required", "message": "'city' is required"},
        {"field": "address.zip", "rule": "length", "message": "'zip' must be at most 5 chars (got 6)",
         "expected": {"max": 5}, "received": 6},
    ]


def test_value_object_is_validated_in_full_inside_a_partial_update() -> None:
    assert _rules(_with_address(), {"address": {}}, partial=True) == ["address.city:required"]


def test_value_object_must_be_an_object() -> None:
    assert _errors(_with_address(), {"address": "x"}) == [{
        "field": "address", "rule": "type", "message": "'address' must be a Address object",
        "expected": "Address", "received": "string",
    }]


def test_value_object_array_elements_are_indexed() -> None:
    e = _with_address(is_array=True)
    assert _rules(e, {"address": [{"city": "A"}, {}]}) == ["address[1].city:required"]
    assert _errors(e, {"address": {"city": "A"}}) == [{
        "field": "address", "rule": "type", "message": "'address' must be an array of Address",
        "expected": "array", "received": "object",
    }]
    assert _errors(e, {"address": [None]})[0]["received"] == "null"


# ── inheritance (ADR-0039) ───────────────────────────────────────────────────


def test_constraints_inherited_through_extends_are_enforced() -> None:
    base = {"object.entity": {"name": "Base", "isAbstract": True, "children": [
        _with(_string("title", required=True, maxLength=3), {"validator.regex": {"@pattern": "[a-z]+"}}),
    ]}}
    doc = {"metadata.root": {"package": "p", "children": [
        base, {"object.entity": {"name": "Post", "extends": "Base", "children": []}},
    ]}}
    result = MetaDataLoader.from_string(json.dumps(doc))
    assert not result.errors, [str(e) for e in result.errors]
    post = next(c for c in result.root.children() if isinstance(c, MetaObject) and c.name == "Post")
    assert _rules(post, {}) == ["title:required"]
    assert _rules(post, {"title": "ABCD"}) == ["title:length", "title:regex"]


# ── ObjectManager.validate (standalone, no DB hit) ───────────────────────────


def test_object_manager_validate_returns_the_runner_result() -> None:
    from metaobjects.runtime import ObjectManager, PostgresDriver

    doc = {"metadata.root": {"package": "p", "children": [
        {"object.entity": {"name": "Post", "children": [_string("title", required=True)]}},
    ]}}
    result = MetaDataLoader.from_string(json.dumps(doc))
    assert not result.errors
    # validate() never touches the driver, so no connection is needed.
    om = ObjectManager(result.root, PostgresDriver(None))  # type: ignore[arg-type]
    assert om.validate("Post", {"title": "ok"}).ok is True
    assert [e.to_dict() for e in om.validate("Post", {}).errors] == [
        {"field": "title", "rule": "required", "message": "'title' is required"},
    ]


# ── cross-runner parity details ──────────────────────────────────────────────


def test_package_qualified_object_ref_picks_the_object_in_that_package() -> None:
    from metaobjects.loader.meta_data_loader import InMemoryStringSource

    def doc(pkg: str, child: dict) -> str:
        return json.dumps({"metadata.root": {"package": pkg, "children": [child]}})

    result = MetaDataLoader().load([InMemoryStringSource(text) for text in (
        doc("shipping", {"object.value": {"name": "Address", "children": [_string("zip", required=True)]}}),
        doc("billing", {"object.value": {"name": "Address", "children": [_string("city", required=True)]}}),
        doc("orders", {"object.entity": {"name": "Order", "children": [
            {"field.object": {"name": "addr", "@objectRef": "billing::Address"}},
        ]}}),
    )])
    assert not result.errors, [str(e) for e in result.errors]
    order = next(c for c in result.root.children() if c.name == "Order")
    assert _rules(order, {"addr": {"city": "NYC"}}) == []
    assert _rules(order, {"addr": {"zip": "12345"}}) == ["addr.city:required"]


def test_bare_object_ref_resolves_in_the_declaring_entitys_own_package() -> None:
    from metaobjects.loader.meta_data_loader import InMemoryStringSource

    def doc(pkg: str, child: dict) -> str:
        return json.dumps({"metadata.root": {"package": pkg, "children": [child]}})

    # shipping loads first, so a first-match-of-that-name scan would bind its Address.
    result = MetaDataLoader().load([InMemoryStringSource(text) for text in (
        doc("shipping", {"object.value": {"name": "Address", "children": [_string("zip", required=True)]}}),
        doc("billing", {"object.entity": {"name": "Order", "children": [
            {"field.object": {"name": "addr", "@objectRef": "Address"}},
        ]}}),
        doc("billing", {"object.value": {"name": "Address", "children": [_string("city", required=True)]}}),
    )])
    assert not result.errors, [str(e) for e in result.errors]
    order = next(c for c in result.root.children() if c.name == "Order")
    assert _rules(order, {"addr": {"city": "NYC"}}) == []
    assert _rules(order, {"addr": {"zip": "12345"}}) == ["addr.city:required"]


def test_numbers_in_messages_print_as_javascript_prints_them() -> None:
    from metaobjects.runtime.validator_runner import _js_number

    # Each pair is (value, what a JS template literal prints for it).
    for value, printed in [
        (0, "0"), (-1, "-1"), (2.0, "2"), (-0.0, "0"), (1.5, "1.5"), (0.1, "0.1"),
        (1e-5, "0.00001"), (1e-6, "0.000001"), (1e-7, "1e-7"), (1.5e-7, "1.5e-7"),
        (123456789.125, "123456789.125"), (1e21, "1e+21"), (1.5e22, "1.5e+22"), (1e20, "100000000000000000000"),
        (float("inf"), "Infinity"), (float("-inf"), "-Infinity"), (float("nan"), "NaN"),
        ("5", "5"),
    ]:
        assert _js_number(value) == printed, value


def test_a_small_value_prints_as_javascript_prints_it() -> None:
    # Validator bounds are int-typed in the metamodel, so only the VALUE can be fractional.
    e = _load({"field.double": {"name": "ratio", "children": [{"validator.numeric": {"@min": 1}}]}})
    assert _errors(e, {"ratio": 0.000001})[0]["message"] == "'ratio' must be at least 1 (got 0.000001)"
    assert _errors(e, {"ratio": 1e-7})[0]["message"] == "'ratio' must be at least 1 (got 1e-7)"
