// FR-040 §4.1 — this package hosts its own copyable reference generators in
// `src/reference/`, read through the shared factory so the resolver is not duplicated.
import { makeReferenceReader } from "@metaobjectsdev/codegen-ts";

export const REFERENCE_GENERATOR_NAMES = ["hooks", "grid", "grid-hook"] as const;
export type ReferenceGeneratorName = (typeof REFERENCE_GENERATOR_NAMES)[number];

const reader = makeReferenceReader(import.meta.url, REFERENCE_GENERATOR_NAMES);

export function resolveReferenceRoot(): string {
  return reader.resolveReferenceRoot();
}

export function readReferenceTemplate(name: ReferenceGeneratorName): string {
  return reader.readReferenceTemplate(name);
}
