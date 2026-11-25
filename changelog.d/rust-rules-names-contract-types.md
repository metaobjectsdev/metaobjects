- **Rust port's rules layers 0 and 1: `rules-names` and `contract-types` (ADR-0067).** Two
  generators read the business-rules vocabulary, and each writes nothing for a model without it.
  `rules-names` writes a `<package>_rules` crate for a package with a lifecycle or a declared
  operation: per entity, each lifecycle's state type (the model's own enum), its states, initial
  and terminal states and its transitions, and the commands derived from unclaimed transitions;
  then the package's operations (kind, permission, claimed transitions, business errors), every
  permission asked about (declared or derived per ADR-0066) and every business error, each as a
  closed enum, plus the five codes the enforcing shell answers with. `contract-types` writes a
  `<package>_contract` crate for a package with a declared operation: each operation's input and
  output types, its business-error enum and its error body (a fixed wire code or one of its own),
  the read shape of a projection it returns, and a shared `meta_contract` crate with the wire
  error codes, their statuses and the validation and constraint-violation bodies. An entity's
  read, create and patch shapes stay in the model crate, which carries no persistence mapping.
  Both are listed in the shared generator registry (Rust only for now) and `eject` copies them.
