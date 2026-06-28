"""The declarative JSON template-spec the CLI ports (Python/C#) consume.

The JSON shape is the cross-port contract (SP-1 §4) — a JSON Schema sits beside
the TS port at codegen-ts/src/template-codegen/template-spec.schema.json. This
module validates + maps it to runnable Generators.
"""

from __future__ import annotations

from typing import Any

from metaobjects.codegen.generator import Generator
from metaobjects.codegen.generators.template_generator import SCOPES, template_generator
from metaobjects.render import escapers
from metaobjects.render.verify import Provider

_FORMATS = (
    escapers.FORMAT_TEXT,
    escapers.FORMAT_HTML,
    escapers.FORMAT_XML,
    escapers.FORMAT_CSV,
    escapers.FORMAT_JSON,
    escapers.FORMAT_MARKDOWN,
    escapers.FORMAT_SPREADSHEET,
)

_REQUIRED_STR = ("name", "template", "scope", "outputPattern")


def parse_template_spec(obj: object) -> dict[str, Any]:
    """Validate + return a normalized ``{"generators": [...]}`` dict. Raises
    ``ValueError`` on any shape violation."""
    if not isinstance(obj, dict) or not isinstance(obj.get("generators"), list):
        raise ValueError("template-spec: expected an object with a `generators` array")
    generators: list[dict[str, Any]] = []
    for i, raw in enumerate(obj["generators"]):
        if not isinstance(raw, dict):
            raise ValueError(f"template-spec generators[{i}]: expected an object")
        for key in _REQUIRED_STR:
            if not isinstance(raw.get(key), str) or raw[key] == "":
                raise ValueError(
                    f"template-spec generators[{i}]: missing or empty required string {key!r}"
                )
        if raw["scope"] not in SCOPES:
            raise ValueError(
                f"template-spec generators[{i}]: scope must be one of "
                f"{' | '.join(SCOPES)}, got {raw['scope']!r}"
            )
        entry: dict[str, Any] = {
            "name": raw["name"],
            "template": raw["template"],
            "scope": raw["scope"],
            "outputPattern": raw["outputPattern"],
        }
        if "format" in raw:
            if raw["format"] not in _FORMATS:
                raise ValueError(
                    f"template-spec generators[{i}]: format must be one of "
                    f"{' | '.join(_FORMATS)}, got {raw['format']!r}"
                )
            entry["format"] = raw["format"]
        if isinstance(raw.get("target"), str):
            entry["target"] = raw["target"]
        generators.append(entry)
    return {"generators": generators}


def template_spec_to_generators(spec: dict[str, Any], provider: Provider) -> list[Generator]:
    """Map a parsed spec into runnable Generators (one per entry). The caller
    supplies the ``provider`` (the CLI builds a ``FilesystemProvider``)."""
    out: list[Generator] = []
    for e in spec["generators"]:
        out.append(
            template_generator(
                name=e["name"],
                template=e["template"],
                scope=e["scope"],
                output_pattern=e["outputPattern"],
                provider=provider,
                format=e.get("format", escapers.FORMAT_TEXT),
            )
        )
    return out
