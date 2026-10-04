# Python Run-time Validator Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Python port a run-time validator runner equal to TypeScript's `runValidators`, and make both runners pass `fixtures/validation-conformance/`.

**Architecture:** One pure function per port — it never raises, it collects every failure as `{field, rule, message, expected?, received?}`. TypeScript's `runValidators` is the contract. The corpus gates boolean verdicts; a new sibling file `runtime-errors.json` pins the exact failure list so the two runners cannot drift in structure or message text.

**Tech Stack:** Python 3 standard library only (`re`), pytest; TypeScript, `bun test`.

**Spec:** no separate spec. The contract is `server/typescript/packages/runtime-ts/src/validator-runner.ts` plus `fixtures/validation-conformance/README.md`.

## Global Constraints

- No new vocabulary, no new validator subtype, no metamodel change. Java is not touched.
- The Python runner adds no runtime dependency (`PyYAML` stays the only one).
- ADR-0039: read effective values. Python `attr()` is OWN-only — use `get_meta_attr()` / `children()`. The one own read is `@dbColumnType`.
- Rules, rule names, field labels and message text are byte-identical in both runners.
- The behaviour change for TypeScript users goes in `CHANGELOG.md` under `[Unreleased]` (the 1.1 line).

## The rules both runners implement

Per field, in declaration order (effective children):

1. **required** — `mustBePresent = @required | validator.required | assigned primary key with no @default`. An assigned primary key is a field of the primary identity whose `@generation` is neither `increment` nor `uuid`. Absent or null → `{rule: "required", message: "'f' is required"}`. Existing exemptions are unchanged (`partial` and absent; `@default` and absent; `storeFilled` and absent).
2. Open-bag jsonb string, value-object recursion: unchanged.
3. **array** (new) — on an array field, `validator.array @min/@max` bounds the element count:
   `{rule: "array", message: "'tags' must have at least 1 items (got 0)", expected: {min: 1}, received: 0}` and `"... at most 3 items (got 4)"` with `expected: {max: 3}`. Applies to scalar arrays and value-object arrays.
4. **type** — unchanged, plus `field.uri` / `field.inet` must be a string (`expected string`).
5. **length** — max is strictest-wins: `min(@maxLength, validator.length @max)`. Min is the authored `validator.length @min` when one is authored (`@min: 0` opts out of the floor), else 1 for a declared-required string, else 0. Messages unchanged. Length counts UTF-16 code units in both ports.
6. **regex** — unchanged (full match).
7. **numeric** (new) — on `field.int|long|currency|double|float`, `validator.numeric @min/@max`, inclusive:
   `{rule: "numeric", message: "'score' must be at least 0 (got -1)", expected: {min: 0}, received: -1}` and `"... at most 100 (got 101)"` with `expected: {max: 100}`. An int64 passed as a numeric string is compared as an integer and echoed as given.
8. **format** (new) — unless `@lenient: true`:
   - `field.uri`: strip leading/trailing characters ≤ U+0020; the rest must match `^[A-Za-z][A-Za-z0-9+.-]*:` with a non-empty remainder, and when the remainder starts with `//` the authority (up to the next `/`, `?` or `#`) must be non-empty. Failure: `{rule: "format", message: "'website' must be an absolute URI", expected: "uri", received: value}`.
   - `field.inet`: must match the IPv4 or IPv6 literal patterns from `codegen-ts/src/templates/net-regex.ts`. Failure: `{rule: "format", message: "'sourceIp' must be an IPv4 or IPv6 address", expected: "inet", received: value}`.

A type failure stops further checks on that value. Order of failures within one value: length max, length min, regex, numeric min, numeric max, format.

## Review Focus

- Python `bool` is an `int`: `True` on a numeric field must be a type failure, as in TypeScript.
- A `1.0` bound must print as `1`, as JavaScript prints it.
- A non-BMP character counts as 2 toward length in both ports.
- An invalid `@pattern` yields a `regex` failure, never an exception.
- `partial=True` with an absent assigned primary key is not a failure; a present `None` is.

---

### Task 1: Pin the failure list — `fixtures/validation-conformance/runtime-errors.json`

- [ ] Add `runtime-errors.json`: `{ "errors": { "<case name>": [ {field, rule, message, expected?, received?} ] } }`, one entry per `expectValid: false` case in `cases.json`.
- [ ] Document the file and the two run-time runners in the corpus `README.md`.

### Task 2: TypeScript `runValidators` — corpus + new rules

**Files:** modify `server/typescript/packages/runtime-ts/src/validator-runner.ts`; tests in `server/typescript/packages/runtime-ts/test/validator-runner.test.ts`; create `server/typescript/packages/integration-tests/test/validation-conformance-runtime.test.ts`; modify `scripts/ci-local.sh` (`gate_conf_ts`).

- [ ] Write the corpus runner test: load `meta.json`, run each case through `runValidators`, assert `result.ok === expectValid`, and for a failing case assert `result.errors` deep-equals `runtime-errors.json`. Run it; expect the uri/inet/numeric/array/length/assigned-PK cases to fail.
- [ ] Add unit tests for rules 1, 3, 5, 7, 8 and the Review Focus lines that apply to TypeScript. Run; expect failures.
- [ ] Implement the rules. Run both test files; expect green. Run `bun test` in `runtime-ts` and `bun run --filter '*' typecheck`.
- [ ] Commit.

### Task 3: Python `run_validators`

**Files:** create `server/python/src/metaobjects/runtime/validator_runner.py`; modify `server/python/src/metaobjects/runtime/__init__.py` and `object_manager.py` (`ObjectManager.validate`); tests `server/python/tests/runtime/test_validator_runner.py` and `server/python/tests/runtime/test_validation_conformance_runtime.py`.

**Interfaces:**

```python
@dataclass(frozen=True)
class ValidationFailure:
    field: str
    rule: str
    message: str
    expected: object = None
    received: object = None
    def to_dict(self) -> dict[str, object]: ...   # omits expected/received when None

@dataclass(frozen=True)
class ValidationResult:
    ok: bool
    errors: tuple[ValidationFailure, ...] = ()

def run_validators(entity: MetaData, data: Mapping[str, object], *,
                   partial: bool = False, store_filled: Sequence[str] = ()) -> ValidationResult: ...

class ObjectManager:
    def validate(self, entity_name: str, data: Mapping[str, object]) -> ValidationResult: ...
```

- [ ] Write the corpus runner test (same assertions as Task 2, `to_dict()` compared with `runtime-errors.json`) and the unit tests, porting `validator-runner.test.ts` case for case plus the Review Focus lines. Run; expect import failure.
- [ ] Implement. Run `uv run pytest tests/runtime -q`, `uv run mypy`, `uv run ruff check`; expect green.
- [ ] Commit.

### Task 4: Docs and changelog

- [ ] `docs/ports/python.md`: document `run_validators` and `ObjectManager.validate`.
- [ ] `docs/CONFORMANCE.md`: correct the corpus case count and note the two run-time runners.
- [ ] `CHANGELOG.md` `[Unreleased]`: Added (Python runner), Changed (TypeScript `runValidators` now enforces numeric, array, uri/inet format, assigned-PK presence, strictest-wins max length, authored `@min` over the floor — a behaviour change).
- [ ] Commit.

### Task 5: Verify

- [ ] `scripts/ci-local.sh` (full) green; one independent review of the branch; fix findings.
