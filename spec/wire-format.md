# Wire Format

The MetaObjects wire format is JSON. Metadata files live in `metaobjects/` at project root, organized by domain concept (e.g., `meta.commerce.json`).

Each file declares its package:

```json
{
  "metadata": {
    "package": "myapp::commerce",
    "children": [
      { "object": { "name": "Program", "subType": "entity", ... } }
    ]
  }
}
```

Multiple objects per file when they share a domain. Projections live inline with their base entities.

See CLAUDE.md "File organization" for current conventions.

> Document under construction.
