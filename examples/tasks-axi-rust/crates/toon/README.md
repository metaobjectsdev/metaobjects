# toon-encode

A TOON (Token-Oriented Object Notation) v4.1 encoder in Rust. It is std-only:
the crate has zero dependencies.

It encodes a JSON-shaped `Value` (null, bool, integer, float, string, array,
insertion-ordered object) as inline primitive arrays, tabular arrays, keyed
tabular objects or list form, with comma, tab or pipe delimiters and a
configurable indent. Output has no trailing newline.

```rust
use toon_encode::{encode, Value};
let v = Value::Object(vec![("n".into(), Value::Int(1))]);
assert_eq!(encode(&v), "n: 1");
```

## Verification

`tests/conformance.rs` runs all 179 cases of the 9 official encode fixtures
(vendored byte-for-byte under `tests/fixtures/`, see `PROVENANCE.md`) and
requires every one to pass. It also asserts the case count, so a fixture that
stops being collected fails the suite instead of shrinking the score. Unit tests
in `src/lib.rs` cover the quoting and number rules.

## Hand-written by design

This is a hand-written runtime. The encoder is deliberately not generated from a
model.
