import { MetaDataLoader, type MetaData } from "@metaobjectsdev/metadata";
import { join } from "node:path";

/** Loads the committed extends fixture — it has an inherited member, which is
 *  what makes it the right model for an EFFECTIVE-serialization assertion. */
export async function loadTestModel(): Promise<MetaData> {
  const dir = join(
    import.meta.dir, "..", "..", "..", "..", "..", "..",
    "fixtures", "conformance", "extends-abstract-base", "input",
  );
  // `fromDirectory` is awaited DIRECTLY — it is not a builder with a .load().
  // This matches the call shape already used in this package's own tests
  // (see test/llm-recorder-contract.test.ts).
  const result = await MetaDataLoader.fromDirectory(dir);
  if (result.errors.length > 0) {
    const errorDetails = result.errors.map((e: unknown) => {
      if (typeof e === 'object' && e !== null && 'message' in e) {
        return (e as { message: string }).message;
      }
      return JSON.stringify(e);
    }).join('; ');
    throw new Error(`fixture failed to load: ${errorDetails}`);
  }
  return result.root;
}
