"""Pydantic describes each model as JSON Schema, so compare those, in both directions of use.

Delete this file once the last call site has moved.
"""
from typing import Any

import pytest
from pydantic import BaseModel

import app.models as existing
from generated import Customer, Order, ShippingAddress


def shape(model: type[BaseModel], mode: str) -> dict[str, Any]:
    """The schema with what does not change behaviour removed: titles and descriptions, the
    order of `required`, and `$ref`, which is inlined so a `str` Enum matches a Literal."""
    schema = model.model_json_schema(mode=mode)
    defs = schema.pop("$defs", {})

    def walk(node: Any, seen: tuple[str, ...] = ()) -> Any:
        if isinstance(node, list):
            return [walk(item, seen) for item in node]
        if not isinstance(node, dict):
            return node
        if "$ref" in node:
            name = node["$ref"].rsplit("/", 1)[-1]
            if name in seen:  # a model that contains itself
                return {"$recursive": name}
            rest = {key: value for key, value in node.items() if key != "$ref"}
            return walk({**defs[name], **rest}, (*seen, name))
        out: dict[str, Any] = {}
        for key, value in node.items():
            if key in ("title", "description"):
                continue
            if key == "properties":
                out[key] = {field: walk(prop, seen) for field, prop in value.items()}
            elif key == "required":
                out[key] = sorted(value)
            elif key == "default":
                out[key] = value
            else:
                out[key] = walk(value, seen)
        return out

    return walk(schema)


@pytest.mark.parametrize("mode", ["validation", "serialization"])
@pytest.mark.parametrize(
    ("hand_written", "generated"),
    [
        (existing.Customer, Customer.Customer),
        (existing.CustomerCreate, Customer.CustomerCreate),
        (existing.ShippingAddress, ShippingAddress.ShippingAddress),
        (existing.Order, Order.Order),
    ],
)
def test_same_shape(hand_written: type[BaseModel], generated: type[BaseModel], mode: str) -> None:
    assert shape(hand_written, mode) == shape(generated, mode)
