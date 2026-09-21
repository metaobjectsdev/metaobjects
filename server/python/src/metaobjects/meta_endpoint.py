"""UI-1 — the metadata API contract.

Python ships the helper and not a mount: neither ``metaobjects.runtime`` nor
``metaobjects.codegen.runtime`` imports a web framework, and one endpoint is not
a reason to make either of them framework-bound. Mount it yourself::

    @app.get(f"/api{META_ROUTE_PATH}")
    def meta() -> Response:
        return Response(meta_json(root), media_type="application/json")

Guard that route with your own authorization — ``/_meta`` publishes the shape of
the model (entity and field names, types, validators, layouts), though no row data.
"""
from __future__ import annotations

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
