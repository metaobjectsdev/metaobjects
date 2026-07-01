# Migrating `identity.secondary @unique:false` → `index.lookup`

`index.lookup` is the correct declaration for a **non-unique query-performance
index**. The `@unique` attribute on `identity.secondary` was always wrong (the
subtype is inherently unique — `@unique:false` was an unsupported override that
had no effect on DDL) and is now rejected by the loader with
`ERR_UNKNOWN_ATTR`.

This guide explains the mechanical rewrite and confirms that the physical
database schema is **unchanged** — no migration SQL is emitted.

---

## Rewrite rule

### Non-unique index (the common case)

`identity.secondary` with `@unique: false` (or any intent to produce a plain,
non-unique index) → **replace with `index.lookup`** and drop the `@unique`
attribute.

**Before:**

```json
{
  "identity.secondary": {
    "name": "idx_orders_session",
    "@fields": ["sessionId"],
    "@unique": false
  }
}
```

**After:**

```json
{
  "index.lookup": {
    "name": "idx_orders_session",
    "@fields": ["sessionId"]
  }
}
```

All physical index attributes (`@orders`, `@using`, `@where`, `@expr`) are
supported on `index.lookup` and carry over unchanged.

### Unique index (stays `identity.secondary`)

`identity.secondary` with `@unique: true` or no `@unique` attribute → **keep
`identity.secondary`** and drop the now-invalid `@unique` attribute (uniqueness
is guaranteed by the subtype itself and never needs to be declared explicitly).

**Before:**

```json
{
  "identity.secondary": {
    "name": "uq_users_email",
    "@fields": ["email"],
    "@unique": true
  }
}
```

**After:**

```json
{
  "identity.secondary": {
    "name": "uq_users_email",
    "@fields": ["email"]
  }
}
```

---

## Mechanical rewrite script

The transformation is safe to apply automatically. The script below rewrites
`.json` metadata files in place. Review the diff with `git diff` before
committing.

```bash
#!/usr/bin/env bash
# Rewrite non-unique identity.secondary → index.lookup in MetaObjects metadata
# JSON files. Operates on all meta.*.json files under ./metaobjects/ (adjust
# the glob for your layout).
#
# IMPORTANT: this is a line-oriented heuristic. Review the output with
# `git diff` and run `meta verify` to confirm zero errors before committing.

set -euo pipefail

find metaobjects -name 'meta.*.json' -print0 | while IFS= read -r -d '' file; do
  # Step 1: replace identity.secondary entries that contain "@unique": false
  # with index.lookup (remove the @unique line).
  # This uses Python for reliable multi-line JSON key surgery.
  python3 - "$file" <<'PYEOF'
import json, sys, re

path = sys.argv[1]
with open(path) as f:
    text = f.read()

data = json.loads(text)

def transform(node):
    if not isinstance(node, dict):
        return node
    result = {}
    for key, val in node.items():
        if key == "identity.secondary" and isinstance(val, dict):
            unique = val.get("@unique")
            # Non-unique intent: @unique explicitly false → rewrite to index.lookup
            if unique is False:
                new_val = {k: v for k, v in val.items() if k != "@unique"}
                result["index.lookup"] = new_val
            else:
                # Unique (true or absent): keep as identity.secondary, drop @unique
                new_val = {k: v for k, v in val.items() if k != "@unique"}
                result["identity.secondary"] = new_val
        elif isinstance(val, (dict, list)):
            result[key] = transform(val)
        else:
            result[key] = val
    return result

def transform_list(node):
    if isinstance(node, list):
        return [transform_list(item) if isinstance(item, list)
                else transform(item) if isinstance(item, dict)
                else item
                for item in node]
    return transform(node)

out = json.dumps(transform_list(data), indent=2)
with open(path, "w") as f:
    f.write(out + "\n")
print(f"  rewrote: {path}")
PYEOF
done

echo "Done. Run 'meta verify' to confirm zero loader errors."
```

---

## No DDL churn — the physical schema is unchanged

The physical index produced by `index.lookup` is byte-identical to the non-unique
index that the old `identity.secondary @unique:false` would have produced. The
`meta migrate` diff engine recognises this and emits **no migration SQL** — the
`CREATE INDEX` statement already exists with the correct name, columns, and
ordering.

If you run `meta migrate` after the rewrite and see an unexpected `DROP INDEX` /
`CREATE INDEX` pair, verify that:

1. The index `name` is identical in both forms.
2. The `@fields` list is unchanged (field names, not column names — the column
   naming strategy is applied by the toolchain, not by the metadata author).
3. Any `@orders`, `@using`, `@where`, or `@expr` values are carried over verbatim.

---

## Diagnosing the `ERR_UNKNOWN_ATTR` error

If `meta verify` or `meta gen` reports:

```
ERR_UNKNOWN_ATTR: "@unique" is not a registered attribute for "identity.secondary"
```

a metadata file still contains `@unique` on an `identity.secondary` node. The
rewrite script above eliminates all occurrences; if the error persists after
running it, grep for any remaining occurrences:

```bash
grep -r '"@unique"' metaobjects/
```

Each hit is a remaining `@unique` that must be either removed (for
`identity.secondary`, where uniqueness is the subtype default) or relocated to an
`index.lookup` node (which does not accept `@unique` either — non-uniqueness is
its subtype default).
