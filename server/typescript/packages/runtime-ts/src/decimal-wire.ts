// The wire spelling of a field.decimal that a read-only mount SENDS.
//
// A decimal is a string on the wire: it is the string Postgres `numeric` and MySQL `DECIMAL`
// really return, and the string the TypeScript read schema types it as. SQLite has no
// decimal. A decimal field on a table is a `text` column and stays a string, but the value
// a report's view computes (a ratio, an average, a sum of a decimal field) is a REAL, which
// a SQLite driver hands back as a JS number. Sent as it is, the same route answers
// `"paidShare": "0.4"` on Postgres and `"paidShare": 0.4` on SQLite, and the type says
// `string` for both.
//
// So a mount takes the NAMES of its decimal fields (`decimalColumns`, which the generated
// report route passes on SQLite) and sends a number among them as its string. Which keys are
// decimals comes from the caller, never from the shape of a value: an integer column is not
// a decimal because it is a number. A string, a null and anything else pass through. The
// digits are JavaScript's own shortest round-trip spelling of the double (`1.6666666666666667`);
// like every decimal's spelling on the wire, they are the engine's and not part of the contract.

/** Rewrite a number under any of `columns` to its string. Returns `undefined` when there is nothing to do. */
export function decimalWire(
  columns: readonly string[] | undefined,
): ((row: unknown) => unknown) | undefined {
  if (columns === undefined || columns.length === 0) return undefined;
  return (row) => {
    if (row === null || typeof row !== "object") return row;
    const out = { ...(row as Record<string, unknown>) };
    for (const c of columns) {
      const v = out[c];
      if (typeof v === "number") out[c] = String(v);
    }
    return out;
  };
}
