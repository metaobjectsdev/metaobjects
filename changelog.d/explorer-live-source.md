- **runtime-ts: `GET {apiPrefix}/_meta/docs` serves the loaded model's docs view, and the
  explorer follows it.** New `mountMetaDocsRoute` (Fastify) and `mountMetaDocsRouteHono` mount
  it beside `/_meta`, opt-in and guarded the same way, with `META_DOCS_ROUTE_PATH` and
  `metaDocsJson(root, { routes })` for other hosts. The response carries an ETag and answers a
  matching `If-None-Match` with `304`; `allowOrigin` opts in to cross-origin reads. Open the
  explorer app as `index.html?source=<that URL>` and it reads the running application's model
  instead of the generated file, once a second, drawing the open page again when the
  application restarts on a changed model. The route's shape is a cross-port contract
  (`docs/features/metadata-api.md`); the other ports serve it once they have their docs view
  builders.
