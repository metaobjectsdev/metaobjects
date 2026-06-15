# json-depth-guard-fallback

A nine-level singular object chain (`n1 → n2 → … → n9 → leaf`) that drives the
renderer **past `MAX_NEST_DEPTH` (8)**. At depth 8 the depth guard stops recursing
and emits the flat `{n9}` placeholder instead of expanding `n9`'s `leaf` child —
proving the renderer never recurses unboundedly on a deeply (or cyclically) nested
payload.

`roundTrip: false`: the fallback `{n9}` is a placeholder, not a real value, so the
exampleOnly fragment is intentionally not extract-clean. The point is the byte-exact
fallback shape, identical across every port (all share `MAX_NEST_DEPTH = 8`).
