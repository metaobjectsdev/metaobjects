// Canonical Zod emission for `field.inet` (IPv4 or IPv6 literal).
//
// We deliberately emit an explicit regex union rather than Zod's built-in IP
// validator: `z.string().ip()` was REMOVED in Zod 4 (the workspace + generated
// consumers run Zod 4), while the Zod-4 replacement `z.union([z.ipv4(),z.ipv6()])`
// does not exist on Zod 3. This regex form is valid on BOTH Zod 3 and Zod 4 (the
// codegen peer is `zod >=3.23.0`), mirroring the `@stringFormat: hostname`
// regex precedent in `field-meta.ts`. The two patterns are Zod 4's OWN `ipv4`
// and `ipv6` regexes (from `zod/src/v4/core/regexes.ts`), so behavior matches
// Zod's native validators on the pinned validation-conformance probe set.
//
// Contract (#234, ADR-0037): a strict `field.inet` accepts an IPv4 or IPv6
// LITERAL only — no hostnames (never a DNS lookup), no CIDR, no padding.
export const ZOD_INET_EXPR =
  "z.string().regex(/^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/)" +
  ".or(z.string().regex(/^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/))";
