# Migration — the Python `ObjectManager` splits into `ObjectManager` and `ObjectManagerDb` (`1.3.0`)

**Breaking, Python only, and by hand.** The class you constructed with
`ObjectManager(root, driver)` is now `ObjectManagerDb(root, driver)`. `ObjectManager` is the
abstract contract (the Java `ObjectManager` / `ObjectManagerDB` shape), and constructing it
raises a `TypeError` that names the replacement. There is no shim: an alias that quietly kept
the old constructor working would keep code written against a concrete class, which is the
coupling the split removes.

## What to change

| Before | After |
|---|---|
| `from metaobjects.runtime import ObjectManager` then `ObjectManager(root, driver)` | `from metaobjects.runtime import ObjectManagerDb` then `ObjectManagerDb(root, driver)` |
| `from metaobjects.runtime.object_manager import ObjectManager` | `from metaobjects.runtime.object_manager_db import ObjectManagerDb` (a type annotation that should accept any manager keeps `ObjectManager`) |
| `from metaobjects.runtime.object_manager import DbApiDriver, PostgresDriver, SelectResult` | the same names from `metaobjects.runtime` or `metaobjects.runtime.drivers` |
| `metaobjects.runtime.object_manager._coerce_write_value`, `_decode_read_value`, `_coerce_key_value`, `_coerce_filter_value` (private) | `metaobjects.runtime.values.coerce_write_value`, `decode_read_value`, `coerce_key_value`, `coerce_filter_value` (public) |

Nothing else about the constructor changed: the driver and the loaded root are the same, and so
is every method (`create`, `insert_preserving`, `update`, `delete`, `find_by_id`, `find_many`,
`count`, `relate`, `validate`, `primary_key_field`). Hand-written code that only calls those
methods should be typed against `ObjectManager`, so it runs against any manager.

A search that finds every site: `grep -rn "ObjectManager(" .`

## What is new

* **Transactions.** `with om.transaction(): ...` holds every write in the block on the
  connection and commits once when the outermost block ends, or rolls all of it back when the
  block raises. A block inside a block joins it (no savepoint). A write outside any block still
  commits on its own, as before. `DbApiDriver.transaction()` is the same thing one level down,
  for code that holds a driver and no manager.
* **Listeners.** `om.add_listener(listener)` registers a `PersistenceListener` (override only
  the methods you need: `on_before_create` / `on_after_create`, `..._update`, `..._delete`).
  A `before` method may raise to refuse the write. Inside a transaction an `after` method runs
  before the commit, so an exception from it rolls the transaction back.
* **A contract other stores can implement.** Subclass `ObjectManager`, supply `find_many`,
  `count`, `relate`, `transaction`, `_insert_row`, `_update_row` and `_delete_row`, and the
  base class does the rest (report refusal, `@autoSet` stamping, listeners, `find_by_id`,
  `validate`).
* **The value codecs are a module.** `metaobjects.runtime.values` holds the write and read
  conversion (decimals, uuids, temporals, durations, int-backed enums, arrays of value
  objects) and `@autoSet` stamping, with no SQL in it.

## What did not change

Reads and writes return the same rows, with the same SQL, on Postgres, SQLite and MySQL. The
persistence, API-contract and query conformance corpora run unmodified against
`ObjectManagerDb`.
