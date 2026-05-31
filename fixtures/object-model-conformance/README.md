# object-model-conformance

Shared metadata (`meta.json`) + the scenarios every port's runtime object model must satisfy.
Each port loads `meta.json` and runs these against its MetaObject / MetaField / ValueObject /
ObjectClassRegistry + newInstance factory. Assertions are behavioral (type-kind, back-ref
identity, field values, list contents, overflow) — not byte-identity. Resolve the corpus dir
the same way the port's existing conformance runners resolve sibling corpora (repo-root walk).

## Scenarios (Person = object.value with name:string, age:int, home:Address, tags:Tag[])

1. **instantiate-value** — newInstance(Person) returns the port's map-backed ValueObject (the
   unbound default for object.value); the instance's MetaObject back-reference is the Person MetaObject.
2. **scalar-round-trip** — set name="Ada", age=36; get name == "Ada", age == 36 (integer).
3. **nested-object** — newInstance(Address), set street="1 Main", city="Anytown"; set as Person.home;
   get Person.home → an Address-backed object with street/city as set; its back-reference is the
   Address MetaObject.
4. **array-of-objects** — build [Tag(label="a"), Tag(label="b")]; set Person.tags; get Person.tags →
   ordered list of 2; labels "a","b"; each element's back-reference is the Tag MetaObject.
5. **overflow** — on a ValueObject Person, set key "nickname" (not a declared field); get "nickname"
   round-trips (an instance may hold more than the declared field set).
6. **bound-type** — register a port-local test type (an "aware" type with name/age/home/tags) for FQN
   "com::example::om::Person" in the ObjectClassRegistry; newInstance(Person) returns THAT type (not a
   ValueObject); its back-reference is set; scalar/nested/array get/set behave identically to a
   ValueObject. Use a fresh/scoped registry so it does not leak into other scenarios.
7. **no-binding-fallback** — with nothing registered for Address, newInstance(Address) returns a ValueObject.
