// Public surface for @metaobjectsdev/sdk/agent-docs.
//
// AGENT_DOCS_BODY was removed here. It was the pre-agent-context single-blob agent
// reference: nothing scaffolded it any more, but it stayed exported and README-advertised
// while its prose went on teaching vocabulary the loader rejects (`@label`, `@placeholder`,
// `@helpText`, a `view.text-input` subtype, a validator `@message`) and a grid-sortability
// affordance no generator implemented. A prompt surface nothing assembles cannot be kept
// honest — the live one is `@metaobjectsdev/sdk/agent-context`. Pinned by
// test/agent-docs-body-retired.test.ts.
export {
  computeContentHash,
  withContentHash,
  extractContentHash,
  isUnmodified,
} from "./content-hash.js";
