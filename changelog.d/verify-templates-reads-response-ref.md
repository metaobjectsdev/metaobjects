- **The template check reads `@responseRef`.** `verify`'s template gate now reports
  `ERR_RESPONSE_UNRESOLVED` (error) for a reply type with no readable field, and
  `ERR_RESPONSE_TAG_UNDECLARED` (warning) for an xml prompt's `@requiredTags` tag that names
  neither the reply type nor a field in it. TypeScript, Java (and so Kotlin), C#, Python and
  Rust, pinned by `fixtures/response-verify-conformance/`.
