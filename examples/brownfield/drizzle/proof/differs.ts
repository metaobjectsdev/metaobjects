// Names every field that differs between two object types, or `never` when they match.
//
// Mutual assignability alone is not enough. A field that is optional and present on only one
// side passes both ways, and `any` is assignable to and from everything, so this compares
// key by key and treats `any` on one side as a difference. Pick<> keeps each field's optional
// modifier. It looks one level down: give a nested type its own line in equivalence.ts.
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type IsAny<T> = 0 extends 1 & T ? true : false;

export type Differs<A, B> = {
  [K in keyof A | keyof B]: K extends keyof A & keyof B
    ? [IsAny<A[K]>] extends [IsAny<B[K]>]
      ? Mutual<Pick<A, K>, Pick<B, K>> extends true
        ? never
        : K
      : K
    : K;
}[keyof A | keyof B];

// tsc reports each differing field as: Type '"name"' does not satisfy the constraint 'never'.
export type Same<_NoDifferences extends never> = true;
