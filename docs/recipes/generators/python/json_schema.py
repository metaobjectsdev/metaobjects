"""EXAMPLE GENERATOR — copy into your project as codegen/generators/json_schema.py and own it.

A worked example, NOT a supported MetaObjects product surface: no release promises its output.

Wire it as ``module:symbol`` — in metaobjects.config.yaml:

    targets:
      api:
        outDir: gen
        generators: [codegen.generators.json_schema:json_schema, codegen.generators.json_schema:openapi]

or on the command line: ``metaobjects gen ./metaobjects --out gen --generators
codegen.generators.json_schema:json_schema``. ``metaobjects verify --codegen`` re-runs it with
the same selection and fails when committed output is stale. (codegen/ and
codegen/generators/ need an ``__init__.py`` each so the module imports.)

Emits schemas/<package path>/<Name>.schema.json per concrete object (JSON Schema 2020-12) and
openapi.json (OpenAPI 3.1) with the cross-port CRUD paths for each object that has a source.
"""
from __future__ import annotations

import json
from typing import Any, Callable

from metaobjects.codegen.model_walk import (
    EmittedFile,
    GenContext,
    description,
    enum_values,
    field_is_array,
    is_abstract,
    is_required,
    max_length,
    object_ref_target,
    package_of,
    per_entity,
    per_model,
    primary_key_fields,
    route_path,
)

# field subtype -> JSON Schema, following the cross-port wire contract
# (docs/features/api-contract.md, "Type encodings").
_SCALARS: dict[str, dict[str, Any]] = {
    "string": {"type": "string"},
    "int": {"type": "integer"},
    "long": {"type": "integer"},
    "currency": {"type": "integer"},
    "double": {"type": "number"},
    "float": {"type": "number"},
    "decimal": {"type": "string", "pattern": "^-?\\d+(\\.\\d+)?$"},
    "boolean": {"type": "boolean"},
    "date": {"type": "string", "format": "date"},
    "time": {"type": "string", "format": "time"},
    "timestamp": {"type": "string", "format": "date-time"},
    "uuid": {"type": "string", "format": "uuid"},
    "uri": {"type": "string", "format": "uri"},
    "map": {"type": "object"},
}


def _dump(doc: dict[str, Any]) -> str:
    return json.dumps(doc, indent=2) + "\n"


def schema_path(obj: Any) -> str:
    pkg = package_of(obj)
    return f"schemas/{pkg.replace('::', '/')}/{obj.name}.schema.json" if pkg else f"schemas/{obj.name}.schema.json"


def field_schema(field: Any, ref_for: Callable[[Any], str]) -> dict[str, Any]:
    if field.sub_type == "enum":
        value: dict[str, Any] = {"type": "string", "enum": enum_values(field)}
    elif field.sub_type == "object":
        target = object_ref_target(field)
        value = {"$ref": ref_for(target)} if target is not None else {"type": "object"}
    else:
        value = dict(_SCALARS.get(field.sub_type, {"type": "string"}))
    if (n := max_length(field)) is not None:
        value["maxLength"] = n
    # field_is_array RESOLVES; the raw field.is_array flag misses an inherited isArray.
    schema = {"type": "array", "items": value} if field_is_array(field) else value
    if (d := description(field)) is not None:
        schema["description"] = d
    return schema


def object_schema(obj: Any, ref_for: Callable[[Any], str]) -> dict[str, Any]:
    # fields() RESOLVES: an object that `extends` a base gets the base's fields too.
    fields = obj.fields()
    schema: dict[str, Any] = {
        "title": obj.name,
        "type": "object",
        "properties": {f.name: field_schema(f, ref_for) for f in fields},
    }
    required = [f.name for f in fields if is_required(f)]
    if required:
        schema["required"] = required
    if (d := description(obj)) is not None:
        schema["description"] = d
    return schema


class JsonSchemaGenerator:
    """One JSON Schema per concrete object. A generator is just ``name`` + ``generate``."""

    name = "json-schema"

    def filter(self, obj: Any) -> bool:
        # ctx.entities is EVERY object, abstract bases included; the runner applies this
        # as ctx.matches, which per_entity honours.
        return not is_abstract(obj)

    def generate(self, ctx: GenContext) -> list[EmittedFile]:
        def one(obj: Any, _ctx: GenContext) -> EmittedFile:
            def ref(target: Any) -> str:  # same directory for one package; adjust if yours differ
                return f"./{target.name}.schema.json"

            doc = {"$schema": "https://json-schema.org/draft/2020-12/schema", "$id": schema_path(obj),
                   **object_schema(obj, ref)}
            return EmittedFile(path=schema_path(obj), content=_dump(doc))

        return per_entity(one)(ctx)


class OpenApiGenerator:
    """One OpenAPI 3.1 document for the whole model."""

    name = "openapi"

    def __init__(self, title: str = "API", api_prefix: str = "") -> None:
        self.title = title
        self.api_prefix = api_prefix

    def filter(self, obj: Any) -> bool:
        return not is_abstract(obj)

    def generate(self, ctx: GenContext) -> list[EmittedFile]:
        def whole(objects: list[Any], _ctx: GenContext) -> EmittedFile:
            def ref(target: Any) -> str:
                return f"#/components/schemas/{target.name}"

            schemas = {o.name: object_schema(o, ref) for o in objects}
            paths: dict[str, Any] = {}
            for o in objects:
                # children() RESOLVES, so an inherited source counts; a value object has none.
                if not any(c.type == "source" for c in o.children()):
                    continue
                base = f"{self.api_prefix}/{route_path(o.name)}"
                row = {"$ref": ref(o)}
                body = {"content": {"application/json": {"schema": row}}}
                pk = primary_key_fields(o)
                pk_field = next((f for f in o.fields() if pk and f.name == pk[0]), None)
                id_param = {"name": "id", "in": "path", "required": True,
                            "schema": field_schema(pk_field, ref) if pk_field else {"type": "string"}}
                paths[base] = {
                    "get": {"operationId": f"list{o.name}", "responses": {"200": {
                        "description": "OK",
                        "content": {"application/json": {"schema": {"type": "array", "items": row}}}}}},
                    "post": {"operationId": f"create{o.name}", "requestBody": body,
                             "responses": {"201": {"description": "Created", **body}}},
                }
                paths[f"{base}/{{id}}"] = {
                    "parameters": [id_param],
                    "get": {"operationId": f"get{o.name}", "responses": {"200": {"description": "OK", **body}}},
                    "patch": {"operationId": f"update{o.name}", "requestBody": body,
                              "responses": {"200": {"description": "OK", **body}}},
                    "delete": {"operationId": f"delete{o.name}", "responses": {"204": {"description": "Deleted"}}},
                }
            doc = {"openapi": "3.1.0", "info": {"title": self.title, "version": "0.0.0"},
                   "paths": paths, "components": {"schemas": schemas}}
            return EmittedFile(path="openapi.json", content=_dump(doc))

        return per_model(whole)(ctx)


# The module:symbol targets: an INSTANCE, or a FUNCTION returning one (called for you with no
# arguments). Not the class itself — a class has a `generate` attribute, so it would be taken
# as the generator and called unbound.
def json_schema() -> JsonSchemaGenerator:
    return JsonSchemaGenerator()


def openapi() -> OpenApiGenerator:
    return OpenApiGenerator(title="Shop")
