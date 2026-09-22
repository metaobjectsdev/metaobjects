"""The generator selection the CLI mechanics tests use.

These tests are about the write path, the hash manifest, baselines, column naming,
staleness nudges, provider loading and codegen-drift detection — not about which
generators an application should run. They used to get a suite for free from
``cli._default_generators``, which is gone: codegen is opt-in, and a run that names no
generator is a usage error with an empty out dir.

So the suite is named here, ONCE, and it is deliberately the eight that used to be the
default less ``payload``, which ADR-0056 removed (a template's payload and response types
are the value objects' own models, emitted by ``entity``) — these tests' fixtures and
assertions were written against exactly that output, and changing what they generate would
change what they are testing. This is a test-local convenience, not a default restored by
the back door: nothing in ``metaobjects`` reads it.
"""

#: Stable generator names, comma-joined for ``--generators``.
GEN_SUITE = "entity,routes,filter-allowlist,names,output-parser,output-prompt,extractor"
