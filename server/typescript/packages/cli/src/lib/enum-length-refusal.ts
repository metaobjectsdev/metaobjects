/**
 * A string-stored enum member longer than the project's `enums.maxLength`: core's
 * resolveEnumMaxLength refuses it while the expected schema is built. A metadata (or config)
 * defect, so `meta migrate` and `meta verify` report it by name rather than as an
 * unexpected error. Matched by name and code, not `instanceof`: two physical copies of
 * @metaobjectsdev/metadata in one process give the class two identities.
 */
export const ENUM_LENGTH_CODE = "ERR_ENUM_VALUE_EXCEEDS_MAX_LENGTH";

export const ENUM_LENGTH_HINT =
  "give the enum field its own @maxLength that fits its longest member, raise enums.maxLength in .metaobjects/config.json, or shorten the member";

export function isEnumLengthRefusal(err: unknown): err is Error {
  return err instanceof Error && err.name === "MetaModelError"
    && (err as { code?: unknown }).code === ENUM_LENGTH_CODE;
}
