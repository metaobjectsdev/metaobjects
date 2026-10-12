// ADR-0025 — the packaged doc generators `meta docs` runs and `meta gen` therefore skips.
//
// ONE definition, read by everything that has to agree about it: the runner (which
// warns about and skips one found in a `meta gen` config), `resolveGenerators` (which
// must not offer one as a selectable name) and the CLI catalog (whose row says the
// door is `meta docs`). They used to answer separately — the runner skipped
// `api-docs` while the unknown-name error offered it and `meta gen --list` presented
// it as something to wire.
//
// Keyed by the generator's IMPLEMENTATION name, because that is what a constructed
// generator carries. The value is the factory call an adopter wrote, for the message.
//
// An OWNED copy of one of them (docs-door.ts) is skipped too, by its `docsSurface` marker
// and not by this map: an owner may rename the copy, and the fix for it is a different
// one. A packaged generator is removed from `generators`; an owned copy is moved to
// `docs: { generators: [...] }`, where `meta docs` runs it.
const PACKAGED_DOCS_FACTORY_CALLS: ReadonlyMap<string, string> = new Map([
  ["docs-file", "docsFile()"],
  ["api-docs", "apiDocsFile()"],
  // The other two surfaces `meta docs` runs (ADR-0034 Amendment 8). They were in no registry,
  // so nothing said that `meta gen` is not their door: a wired `requirementsFile()` or
  // `agentDocsFile()` wrote the same pages into the generated-code directory that
  // `meta docs` writes into the docs directory, which is the two-doors defect ADR-0025 closed
  // for the first two. An owned copy of either can now be listed in `docs.generators`, so the
  // packaged ones answer the way the first two do.
  ["requirements-file", "requirementsFile()"],
  ["agent-docs", "agentDocsFile()"],
]);

/** The command that produces what these generators emit. */
export const DOCS_DOOR_COMMAND = "meta docs";

/** True iff `meta gen` warns about and skips the generator with this implementation name. */
export function isPackagedDocsGenerator(implName: string): boolean {
  return PACKAGED_DOCS_FACTORY_CALLS.has(implName);
}

/** The factory call an adopter wrote to wire it (`apiDocsFile()`), for a message. */
export function packagedDocsFactoryCall(implName: string): string {
  return PACKAGED_DOCS_FACTORY_CALLS.get(implName) ?? implName;
}

/** The runner's warning for one skipped doc generator. */
export function packagedDocsSkipWarning(implName: string): string {
  return (
    `[${implName}] docs are produced by '${DOCS_DOOR_COMMAND}' (ADR-0025); ` +
    `remove ${packagedDocsFactoryCall(implName)} from generators. Skipped.`
  );
}
