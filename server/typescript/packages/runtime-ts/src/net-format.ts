// Run-time format checks for `field.uri` and `field.inet` (#234, ADR-0037 — Contract A).
//
// These are deliberately explicit, engine-neutral rules rather than `new URL()` or a
// platform IP parser: the Python `run_validators` runner applies the SAME patterns, so the
// two run-time runners agree on every input and not only on the pinned
// validation-conformance probe set.

// The IPv4 and IPv6 literal patterns the generated Zod schema uses
// (`codegen-ts/src/templates/net-regex.ts`) — no hostnames, no CIDR, no padding, no
// leading-zero octet; IPv6 includes the embedded-IPv4 tails.
const IPV4_RE =
  /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
const IPV6_RE =
  /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|::(ffff(:0{1,4})?:)?((25[0-5]|(2[0-4]|1?[0-9])?[0-9])\.){3}(25[0-5]|(2[0-4]|1?[0-9])?[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1?[0-9])?[0-9])\.){3}(25[0-5]|(2[0-4]|1?[0-9])?[0-9]))$/;

/** True when `value` is an IPv4 or IPv6 literal. */
export function isInetLiteral(value: string): boolean {
  return IPV4_RE.test(value) || IPV6_RE.test(value);
}

// Leading/trailing C0 controls and spaces, which a URL parser strips before parsing.
const URI_PAD_RE = /^[\u0000- ]+|[\u0000- ]+$/g;
// scheme ":" remainder — the remainder may hold anything, including a newline.
const URI_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:([\s\S]*)$/;
const URI_AUTHORITY_END_RE = /[/?#]/;

/**
 * True when `value` is an absolute URI: a scheme, a non-empty remainder and — when the
 * remainder opens an authority with `//` — a non-empty authority. Padding is stripped first.
 */
export function isAbsoluteUri(value: string): boolean {
  const rest = URI_SCHEME_RE.exec(value.replace(URI_PAD_RE, ""))?.[1];
  if (rest === undefined || rest.length === 0) return false;
  if (!rest.startsWith("//")) return true;
  const authority = rest.slice(2).split(URI_AUTHORITY_END_RE)[0] ?? "";
  return authority.length > 0;
}
