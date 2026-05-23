import { describe, test, expect } from "bun:test";
import {
  verify,
  ERR_VAR_NOT_ON_PAYLOAD,
  ERR_PARTIAL_UNRESOLVED,
  ERR_REQUIRED_SLOT_UNUSED,
  type PayloadField,
} from "../src/index.js";
import { InMemoryProvider } from "../src/index.js";

// The AuthorBrief field tree (mirrors the payload-codegen VO walk):
//   displayName: string
//   postCount:   number
//   posts: { title: string; tags: { name: string }[] }[]
const authorBrief: PayloadField[] = [
  { name: "displayName" },
  { name: "postCount" },
  {
    name: "posts",
    fields: [{ name: "title" }, { name: "tags", fields: [{ name: "name" }] }],
  },
];

const codes = (text: string, fields: PayloadField[], opts?: Parameters<typeof verify>[2]) =>
  verify(text, fields, opts).map((e) => e.code);

describe("verify — interpolations against the (flat) payload", () => {
  test("a known scalar var produces no drift", () => {
    expect(verify("Hi {{displayName}}.", authorBrief)).toEqual([]);
  });

  test("an unknown var → ERR_VAR_NOT_ON_PAYLOAD carrying its path", () => {
    const errs = verify("Hi {{notARealField}}.", authorBrief);
    expect(errs).toEqual([{ code: ERR_VAR_NOT_ON_PAYLOAD, path: "notARealField" }]);
  });

  test("unescaped ({{&x}}) and triple ({{{x}}}) interpolations are checked too", () => {
    expect(codes("{{&nope}} {{{alsoNope}}}", authorBrief)).toEqual([
      ERR_VAR_NOT_ON_PAYLOAD,
      ERR_VAR_NOT_ON_PAYLOAD,
    ]);
  });

  test("the implicit iterator {{.}} is always valid", () => {
    expect(verify("{{.}}", authorBrief)).toEqual([]);
  });
});

describe("verify — sections push the contextual VO (the load-bearing case)", () => {
  test("a field of the section's element type resolves", () => {
    expect(verify("{{#posts}}{{title}}{{/posts}}", authorBrief)).toEqual([]);
  });

  test("a non-field of the element type → drift, scoped to the element", () => {
    expect(codes("{{#posts}}{{title}}{{nope}}{{/posts}}", authorBrief)).toEqual([
      ERR_VAR_NOT_ON_PAYLOAD,
    ]);
  });

  test("nested sections push deeper element types", () => {
    expect(verify("{{#posts}}{{#tags}}{{name}}{{/tags}}{{/posts}}", authorBrief)).toEqual([]);
  });

  test("a deeply-nested non-field is drift", () => {
    expect(codes("{{#posts}}{{#tags}}{{bogus}}{{/tags}}{{/posts}}", authorBrief)).toEqual([
      ERR_VAR_NOT_ON_PAYLOAD,
    ]);
  });

  test("inside a section, parent-context fields still resolve (Mustache context-stack walk)", () => {
    // displayName lives on AuthorBrief, not on a post element.
    expect(verify("{{#posts}}{{title}} by {{displayName}}{{/posts}}", authorBrief)).toEqual([]);
  });

  test("a section over a non-field is itself drift", () => {
    expect(codes("{{#ghosts}}{{x}}{{/ghosts}}", authorBrief)).toEqual([ERR_VAR_NOT_ON_PAYLOAD]);
  });

  test("a section over a scalar is a conditional — body stays in the current context", () => {
    expect(verify("{{#postCount}}{{displayName}}{{/postCount}}", authorBrief)).toEqual([]);
    expect(codes("{{#postCount}}{{nope}}{{/postCount}}", authorBrief)).toEqual([
      ERR_VAR_NOT_ON_PAYLOAD,
    ]);
  });
});

describe("verify — inverted sections", () => {
  test("an inverted section over a known field, body in the parent context, is clean", () => {
    expect(verify("{{^posts}}{{displayName}} has none{{/posts}}", authorBrief)).toEqual([]);
  });

  test("an inverted section over a non-field is drift", () => {
    expect(codes("{{^ghosts}}none{{/ghosts}}", authorBrief)).toEqual([ERR_VAR_NOT_ON_PAYLOAD]);
  });
});

describe("verify — dotted paths", () => {
  test("a valid dotted path through a container resolves", () => {
    // posts is an array, but a direct dotted access still validates structurally.
    expect(verify("{{posts.title}}", authorBrief)).toEqual([]);
  });

  test("a dotted path whose tail is not a field → drift, full path reported", () => {
    expect(verify("{{posts.nope}}", authorBrief)).toEqual([
      { code: ERR_VAR_NOT_ON_PAYLOAD, path: "posts.nope" },
    ]);
  });

  test("a dotted path whose head is not a field → drift", () => {
    expect(verify("{{ghost.title}}", authorBrief)).toEqual([
      { code: ERR_VAR_NOT_ON_PAYLOAD, path: "ghost.title" },
    ]);
  });
});

describe("verify — partials via the provider", () => {
  test("an unresolved partial → ERR_PARTIAL_UNRESOLVED with the ref", () => {
    const errs = verify("a {{> g/missing}} b", authorBrief, {
      provider: new InMemoryProvider({}),
    });
    expect(errs).toEqual([{ code: ERR_PARTIAL_UNRESOLVED, path: "g/missing" }]);
  });

  test("a resolved partial's body is checked against the current context", () => {
    const provider = new InMemoryProvider({ "g/frag": "{{displayName}}{{nope}}" });
    expect(codes("{{> g/frag}}", authorBrief, { provider })).toEqual([ERR_VAR_NOT_ON_PAYLOAD]);
  });

  test("a partial inside a section is checked in the pushed context", () => {
    const provider = new InMemoryProvider({ "g/row": "{{title}}{{nope}}" });
    expect(codes("{{#posts}}{{> g/row}}{{/posts}}", authorBrief, { provider })).toEqual([
      ERR_VAR_NOT_ON_PAYLOAD,
    ]);
  });

  test("with no provider, partials are not checked", () => {
    expect(verify("a {{> g/whatever}} b", authorBrief)).toEqual([]);
  });
});

describe("verify — required slots", () => {
  test("a required slot that is referenced produces no warning", () => {
    expect(verify("{{displayName}}", authorBrief, { requiredSlots: ["displayName"] })).toEqual([]);
  });

  test("a required slot never referenced → ERR_REQUIRED_SLOT_UNUSED (warning)", () => {
    expect(verify("{{displayName}}", authorBrief, { requiredSlots: ["postCount"] })).toEqual([
      { code: ERR_REQUIRED_SLOT_UNUSED, path: "postCount" },
    ]);
  });

  test("a required slot referenced only via a section counts as used", () => {
    expect(verify("{{#posts}}{{title}}{{/posts}}", authorBrief, { requiredSlots: ["posts"] })).toEqual(
      [],
    );
  });
});
