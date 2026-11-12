/**
 * Advisory for `meta gen`: the model declares requirements and no generator writes a test for
 * them. A requirement with no test is a claim nothing checks, and the generator that scaffolds
 * one test per claim is a single line in the config, so the run says so. It never changes the
 * exit code, and it goes quiet as soon as a generator named `requirement-tests` is declared
 * (the shipped one, or an owned copy keeping that name).
 */
export const REQUIREMENT_TESTS_GENERATOR = "requirement-tests";

export function requirementTestsAdvice(declaredGenerators: readonly string[], requirementCount: number): string | undefined {
  if (requirementCount === 0 || declaredGenerators.includes(REQUIREMENT_TESTS_GENERATOR)) return undefined;
  const claims = requirementCount === 1 ? "1 requirement" : `${requirementCount} requirements`;
  return (
    `The model declares ${claims} and no generator writes their tests. Wire ` +
    "`requirementTests()` (import it from \"@metaobjectsdev/codegen-ts/generators\") for one test " +
    "stub per requirement, or `meta eject requirement-tests` to own the template."
  );
}
