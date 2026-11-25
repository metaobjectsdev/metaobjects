- **cli: `meta init --with-services` and the `unenforced-lifecycle` advisory (ADR-0067 §6, §8).**
  `init` still writes an empty generator list; `--with-services` writes the recommended service list
  instead (`entityFile()`, `rulesNamesFile()`, `contractTypes()`, `serviceFile()`,
  `serviceRoutesFile()`, with `serviceFile({ interactiveTransactions: false })` on `--d1`) and names
  the packages their output needs. `meta gen --list` names the same list under the catalog.
  `meta verify` now advises, without changing the exit code, when a concrete entity with a source
  declares a lifecycle and no listed service generator covers it: the flat routes do not enforce
  it.
