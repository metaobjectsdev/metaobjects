"""UI-1 — the metadata API contract.

Python ships the helper and not a mount: neither ``metaobjects.runtime`` nor
``metaobjects.codegen.runtime`` imports a web framework, and one endpoint is not
a reason to make either of them framework-bound. Mount it yourself::

    @app.get(f"/api{META_ROUTE_PATH}")
    def meta() -> Response:
        return Response(meta_json(root), media_type="application/json")

The docs view route (``GET /_meta/docs``, the document the model explorer reads) is the
same kind of helper: :func:`meta_docs` builds the body once with its strong ``ETag`` and
answers ``If-None-Match``::

    docs = meta_docs(root)

    @app.get(f"/api{META_DOCS_ROUTE_PATH}")
    def meta_docs_route(request: Request) -> Response:
        headers = {"ETag": docs.etag, "Cache-Control": "no-cache"}
        if docs.matches(request.headers.get("if-none-match")):
            return Response(status_code=304, headers=headers)
        return Response(docs.body, media_type="application/json", headers=headers)

Guard that route with your own authorization — ``/_meta`` publishes the shape of
the model (entity and field names, types, validators, layouts), though no row data.
"""
from __future__ import annotations

from typing import Any

from metaobjects.docs_view import build_docs_view, serialize_docs_view
from metaobjects.meta.meta_data import MetaData
from metaobjects.serializer_json import canonical_serialize_effective

#: The endpoint path, mounted under the host's API prefix. A cross-port contract
#: value — one browser read-model works against every backend.
META_ROUTE_PATH = "/_meta"


def meta_json(root: MetaData) -> str:
    """The response body: the model as EFFECTIVE canonical JSON.

    Effective, not raw: the effective form materializes the super-chain merge, so
    a browser reading it never resolves ``extends`` itself.
    """
    return canonical_serialize_effective(root)


#: The docs view endpoint's path, mounted under the host's API prefix beside
#: :data:`META_ROUTE_PATH`. A cross-port contract value: the model explorer reads
#: ``GET {apiPrefix}/_meta/docs`` from any backend.
META_DOCS_ROUTE_PATH = META_ROUTE_PATH + "/docs"


def meta_docs_json(root: MetaData, routes: Any = None) -> str:
    """The ``GET {apiPrefix}/_meta/docs`` response body: the loaded model's docs view, built
    from the model alone (no verify payload, no generation manifest, which a running
    application does not hold), with the same bytes every port writes for the same model.

    ``routes`` (``[{ node, method, path }]``, ``node`` a resolution key) are listed on each node.
    """
    return serialize_docs_view(build_docs_view(root, None, None, routes))


def meta_docs_etag(body: str) -> str:
    """A strong ETag for a docs view body: its length and the 32-bit FNV-1a hash of its UTF-16
    code units, quoted, the same value TypeScript's mount and the JVM helper send. The contract
    is only that the tag changes when the body does; a client compares it and never parses it."""
    units = body.encode("utf-16-le", "surrogatepass")
    h = 0x811C9DC5
    for i in range(0, len(units), 2):
        h ^= units[i] | (units[i + 1] << 8)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return f'"{len(units) // 2:x}-{h:08x}"'


def etag_matches(if_none_match: str | None, etag: str) -> bool:
    """Whether an ``If-None-Match`` header value names ``etag`` (or is ``*``): answer 304."""
    if not if_none_match:
        return False
    for token in if_none_match.split(","):
        v = token.strip()
        if v.startswith("W/"):
            v = v[2:]
        if v == "*" or v == etag:
            return True
    return False


class MetaDocs:
    """A built docs view body and its strong ``ETag``: build once, the model is immutable after load."""

    def __init__(self, body: str) -> None:
        self.body = body
        self.etag = meta_docs_etag(body)

    def matches(self, if_none_match: str | None) -> bool:
        """Whether ``if_none_match`` names this body's tag (or is ``*``): answer 304."""
        return etag_matches(if_none_match, self.etag)


def meta_docs(root: MetaData, routes: Any = None) -> MetaDocs:
    """The docs view of one loaded model, built once, with its ``ETag``."""
    return MetaDocs(meta_docs_json(root, routes))
