# enum-normalize-ambiguous-inherited-collapse

A **negative** companion to `warning-enum-normalize-ambiguous`: both vocabularies here contain a
concatenation collision under `strip` (`READ` + `WRITE` == `READWRITE`; `SOCIAL` + `ATTACK` ==
`SOCIALATTACK`), but neither may warn, because the effective `@normalize` is `collapse` — which
folds only `[\s_-]+` and therefore cannot merge tokens across a delimiter like `|`.

It exists to discriminate the two **resolution tiers** a port must implement for
`WARN_ENUM_NORMALIZE_AMBIGUOUS`, neither of which the positive fixture exercises:

1. **Field tier** — `Access` declares `@normalize: collapse` on the enum itself.
2. **Owning-object tier** — `Grant.scope` declares no `@normalize`; the mode comes from its owning
   `object.value`. A port that only looked at the field would fall through to the `strip` default
   and warn.

A port that reads the mode with an **own-only** accessor, or that skips the owning-object tier, or
that gates on the wrong mode, emits a warning here and fails the fixture. Expected warnings are
therefore empty.

Cross-port note: the accessor idiom differs per port and the naming is inverted between them
(ADR-0039) — Python's `attrs()` resolves while its `attr()` is own-only, the opposite of TS/Java.
That inversion is exactly the kind of mistake this fixture is here to catch.
