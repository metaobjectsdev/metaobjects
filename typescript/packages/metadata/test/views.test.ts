import { describe, it, expect } from "bun:test";
import { Loader } from "../src/loader.js";
import {
  metaOf,
  MetaData,
  MetaRoot,
  MetaObject,
  MetaField,
  MetaIdentity,
  MetaPrimaryIdentity,
  MetaSecondaryIdentity,
  MetaRelationship,
  MetaValidator,
  MetaRequiredValidator,
  MetaLengthValidator,
  MetaRegexValidator,
  MetaNumericValidator,
  MetaArrayValidator,
  MetaView,
  MetaAttr,
  MetaLayout,
  MetaSource,
  MetaOrigin,
} from "../src/views.js";
import { TYPE_LAYOUT, TYPE_SOURCE, TYPE_ORIGIN } from "../src/constants.js";

function load(json: string) {
  const loader = new Loader();
  return loader.loadJsonStrings([{ content: json, sourceName: "test.json" }]);
}

const SAMPLE = JSON.stringify({
  metadata: {
    package: "demo",
    children: [
      {
        object: {
          name: "User",
          subType: "entity",
          "@javaRuntime": "pojo",
          children: [
            { source: { subType: "dbTable", "@name": "users" } },
            { field: { name: "id", subType: "long", "@dbColumn": "id" } },
            {
              field: {
                name: "email",
                subType: "string",
                "@dbColumn": "email",
                "@maxLength": 255,
                "@unique": true,
                children: [{ validator: { subType: "required" } }],
              },
            },
            {
              field: {
                name: "displayName",
                subType: "string",
                "@dbColumn": "display_name",
                "@default": "anonymous",
                children: [
                  { validator: { subType: "length", "@min": 1, "@max": 100 } },
                ],
              },
            },
            {
              identity: {
                name: "pk",
                subType: "primary",
                "@fields": ["id"],
                "@generation": "increment",
              },
            },
            {
              identity: {
                name: "idx_users_email",
                subType: "secondary",
                "@fields": ["email"],
                "@unique": true,
              },
            },
            {
              relationship: {
                name: "posts",
                subType: "association",
                "@cardinality": "many",
                "@objectRef": "demo::Post",
                "@fkField": "userId",
              },
            },
          ],
        },
      },
    ],
  },
});

describe("metaOf factory", () => {
  it("returns MetaRoot for metadata type", () => {
    const { root } = load(SAMPLE);
    const view = metaOf(root);
    expect(view).toBeInstanceOf(MetaRoot);
    expect(view).toBeInstanceOf(MetaData);
  });

  it("returns MetaObject for object type", () => {
    const { root } = load(SAMPLE);
    const userModel = root.children().find((c) => c.name === "User")!;
    const view = metaOf(userModel);
    expect(view).toBeInstanceOf(MetaObject);
  });

  it("returns MetaField for field type", () => {
    const { root } = load(SAMPLE);
    const userModel = root.children().find((c) => c.name === "User")!;
    const emailModel = userModel.children().find((c) => c.name === "email")!;
    const view = metaOf(emailModel);
    expect(view).toBeInstanceOf(MetaField);
  });

  it("throws on unknown type", () => {
    // Synthesize a fake model with an unknown type — the factory should reject.
    const fake = {
      type: "frobnicator",
      fqn: () => "x::frobnicator",
      // minimal stub
    } as never;
    expect(() => metaOf(fake)).toThrow(/unknown metadata type/);
  });
});

describe("MetaData base accessors", () => {
  it("exposes name / type / subType / package / fqn", () => {
    const { root } = load(SAMPLE);
    const r = new MetaRoot(root);
    expect(r.package).toBe("demo");
    const user = r.findObject("User")!;
    expect(user.name).toBe("User");
    expect(user.type).toBe("object");
    expect(user.subType).toBe("entity");
    // Object nodes don't inherit package from root (Java parser semantics).
    expect(user.package).toBeUndefined();
    expect(user.fqn()).toBe("User");
  });

  it("children() returns typed union preserving insertion order", () => {
    const { root } = load(SAMPLE);
    const user = new MetaRoot(root).findObject("User")!;
    const kids = user.children();
    // 1 source[dbTable] + 3 fields + 2 identities + 1 relationship = 7
    expect(kids).toHaveLength(7);
    expect(kids[0]).toBeInstanceOf(MetaSource);
    expect(kids[1]).toBeInstanceOf(MetaField);
    expect(kids[1]!.name).toBe("id");
    expect(kids[4]).toBeInstanceOf(MetaIdentity);
    expect(kids[6]).toBeInstanceOf(MetaRelationship);
  });

  it("attr() escape hatch returns typed value", () => {
    const { root } = load(SAMPLE);
    const user = new MetaRoot(root).findObject("User")!;
    expect(user.dbTable).toBe("users");
    expect(user.attr<string>("javaRuntime")).toBe("pojo");
    expect(user.attr<string>("nonExistent")).toBeUndefined();
  });
});

describe("MetaRoot", () => {
  it("objects() returns all object children as MetaObject views", () => {
    const { root } = load(SAMPLE);
    const r = new MetaRoot(root);
    const objs = r.objects();
    expect(objs).toHaveLength(1);
    expect(objs[0]).toBeInstanceOf(MetaObject);
    expect(objs[0]!.name).toBe("User");
  });

  it("findObject() looks up by name", () => {
    const { root } = load(SAMPLE);
    const r = new MetaRoot(root);
    expect(r.findObject("User")).toBeInstanceOf(MetaObject);
    expect(r.findObject("Nope")).toBeUndefined();
  });
});

describe("MetaObject", () => {
  it("exposes dbTable + javaRuntime", () => {
    const { root } = load(SAMPLE);
    const user = new MetaRoot(root).findObject("User")!;
    expect(user.dbTable).toBe("users");
    expect(user.javaRuntime).toBe("pojo");
  });

  it("isEntity / isValue subtype checks", () => {
    const { root } = load(SAMPLE);
    const user = new MetaRoot(root).findObject("User")!;
    expect(user.isEntity()).toBe(true);
    expect(user.isValue()).toBe(false);
  });

  it("fields() returns typed MetaField children", () => {
    const { root } = load(SAMPLE);
    const user = new MetaRoot(root).findObject("User")!;
    const fields = user.fields();
    expect(fields).toHaveLength(3);
    expect(fields.every((f) => f instanceof MetaField)).toBe(true);
    expect(fields.map((f) => f.name)).toEqual(["id", "email", "displayName"]);
  });

  it("identities() / primaryIdentity / secondaryIdentities", () => {
    const { root } = load(SAMPLE);
    const user = new MetaRoot(root).findObject("User")!;
    expect(user.identities()).toHaveLength(2);
    expect(user.primaryIdentity()?.name).toBe("pk");
    expect(user.primaryIdentity()?.isPrimary()).toBe(true);
    const sec = user.secondaryIdentities();
    expect(sec).toHaveLength(1);
    expect(sec[0]!.name).toBe("idx_users_email");
  });

  it("relationships() returns typed MetaRelationship children", () => {
    const { root } = load(SAMPLE);
    const user = new MetaRoot(root).findObject("User")!;
    const rels = user.relationships();
    expect(rels).toHaveLength(1);
    expect(rels[0]!.name).toBe("posts");
  });

  it("findField() looks up by name", () => {
    const { root } = load(SAMPLE);
    const user = new MetaRoot(root).findObject("User")!;
    expect(user.findField("email")?.name).toBe("email");
    expect(user.findField("nope")).toBeUndefined();
  });
});

describe("MetaField", () => {
  it("exposes dbColumn + maxLength + default + unique", () => {
    const { root } = load(SAMPLE);
    const user = new MetaRoot(root).findObject("User")!;
    const email = user.findField("email")!;
    expect(email.dbColumn).toBe("email");
    expect(email.maxLength).toBe(255);
    expect(email.unique).toBe(true);

    const display = user.findField("displayName")!;
    expect(display.default).toBe("anonymous");
    expect(display.unique).toBe(false);
  });

  it("isRequired walks validator children", () => {
    const { root } = load(SAMPLE);
    const user = new MetaRoot(root).findObject("User")!;
    expect(user.findField("email")!.isRequired).toBe(true);
    expect(user.findField("id")!.isRequired).toBe(false);
    expect(user.findField("displayName")!.isRequired).toBe(false);
  });

  it("validators() returns typed MetaValidator children", () => {
    const { root } = load(SAMPLE);
    const user = new MetaRoot(root).findObject("User")!;
    const display = user.findField("displayName")!;
    const vs = display.validators();
    expect(vs).toHaveLength(1);
    expect(vs[0]!.isLength()).toBe(true);
    expect(vs[0]!.min).toBe(1);
    expect(vs[0]!.max).toBe(100);
  });
});

describe("MetaIdentity", () => {
  it("fields / generation / unique accessors", () => {
    const { root } = load(SAMPLE);
    const user = new MetaRoot(root).findObject("User")!;
    const pk = user.primaryIdentity()!;
    expect(pk.fields).toEqual(["id"]);
    expect(pk.generation).toBe("increment");
    expect(pk.unique).toBe(true);
    expect(pk.isComposite()).toBe(false);
  });

  it("secondary identity with @unique: false reports unique=false", () => {
    const { root } = load(
      JSON.stringify({
        metadata: {
          package: "demo",
          children: [
            {
              object: {
                name: "X",
                subType: "entity",
                children: [
                  { field: { name: "id", subType: "long" } },
                  { field: { name: "tag", subType: "string" } },
                  {
                    identity: {
                      name: "pk",
                      subType: "primary",
                      "@fields": ["id"],
                      "@generation": "increment",
                    },
                  },
                  {
                    identity: {
                      name: "idx_tag",
                      subType: "secondary",
                      "@fields": ["tag"],
                      "@unique": false,
                    },
                  },
                ],
              },
            },
          ],
        },
      }),
    );
    const x = new MetaRoot(root).findObject("X")!;
    const sec = x.secondaryIdentities()[0]!;
    expect(sec.unique).toBe(false);
    expect(sec.isSecondary()).toBe(true);
  });
});

describe("MetaRelationship", () => {
  it("cardinality / objectRef / fkField", () => {
    const { root } = load(SAMPLE);
    const user = new MetaRoot(root).findObject("User")!;
    const rel = user.relationships()[0]!;
    expect(rel.cardinality).toBe("many");
    expect(rel.objectRef).toBe("demo::Post");
    expect(rel.fkField).toBe("userId");
  });
});

describe("MetaValidator", () => {
  it("isRequired / isLength / isRegex subtype checks", () => {
    const { root } = load(SAMPLE);
    const user = new MetaRoot(root).findObject("User")!;
    const emailValidator = user.findField("email")!.validators()[0]!;
    expect(emailValidator.isRequired()).toBe(true);
    expect(emailValidator.isLength()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Subtype-specific classes — factory dispatches to most specific class
// ---------------------------------------------------------------------------

describe("subtype dispatch — identity", () => {
  it("primary identity → MetaPrimaryIdentity (instanceof MetaIdentity too)", () => {
    const { root } = load(SAMPLE);
    const user = new MetaRoot(root).findObject("User")!;
    const pk = user.primaryIdentity()!;
    expect(pk).toBeInstanceOf(MetaPrimaryIdentity);
    expect(pk).toBeInstanceOf(MetaIdentity);
    expect(pk).toBeInstanceOf(MetaData);
  });

  it("MetaPrimaryIdentity.generation is typed as IdentityGeneration", () => {
    const { root } = load(SAMPLE);
    const pk = new MetaRoot(root).findObject("User")!.primaryIdentity()!;
    expect(pk.generation).toBe("increment");
    // Compile-time: pk.generation is "increment" | "uuid" | "assigned" | undefined.
    // (No way to assert TS type at runtime; existence here is the check.)
  });

  it("secondary identity → MetaSecondaryIdentity (no .generation getter)", () => {
    const { root } = load(SAMPLE);
    const user = new MetaRoot(root).findObject("User")!;
    const sec = user.secondaryIdentities()[0]!;
    expect(sec).toBeInstanceOf(MetaSecondaryIdentity);
    expect(sec).toBeInstanceOf(MetaIdentity);
    // MetaSecondaryIdentity does not expose .generation (TS would reject sec.generation).
    expect((sec as unknown as { generation?: unknown }).generation).toBeUndefined();
  });

  it("identities() returns mixed array with subtype-specific instances", () => {
    const { root } = load(SAMPLE);
    const user = new MetaRoot(root).findObject("User")!;
    const ids = user.identities();
    expect(ids).toHaveLength(2);
    const primaries = ids.filter((i) => i instanceof MetaPrimaryIdentity);
    const secondaries = ids.filter((i) => i instanceof MetaSecondaryIdentity);
    expect(primaries).toHaveLength(1);
    expect(secondaries).toHaveLength(1);
  });
});

describe("subtype dispatch — validator", () => {
  it("required validator → MetaRequiredValidator", () => {
    const { root } = load(SAMPLE);
    const email = new MetaRoot(root).findObject("User")!.findField("email")!;
    const v = email.validators()[0]!;
    expect(v).toBeInstanceOf(MetaRequiredValidator);
    expect(v).toBeInstanceOf(MetaValidator);
    expect(v.isRequired()).toBe(true);
  });

  it("length validator → MetaLengthValidator with typed min/max", () => {
    const { root } = load(SAMPLE);
    const display = new MetaRoot(root)
      .findObject("User")!
      .findField("displayName")!;
    const v = display.validators()[0]!;
    expect(v).toBeInstanceOf(MetaLengthValidator);
    expect(v.min).toBe(1);
    expect(v.max).toBe(100);
  });

  it("regex validator → MetaRegexValidator with .pattern", () => {
    const { root } = load(
      JSON.stringify({
        metadata: {
          package: "demo",
          children: [
            {
              field: {
                package: "demo",
                name: "slug",
                subType: "string",
                children: [
                  { validator: { subType: "regex", "@pattern": "^[a-z-]+$" } },
                ],
              },
            },
          ],
        },
      }),
    );
    const field = new MetaRoot(root).fields().find((f) => f.name === "slug")!;
    const v = field.validators()[0]!;
    expect(v).toBeInstanceOf(MetaRegexValidator);
    expect((v as MetaRegexValidator).pattern).toBe("^[a-z-]+$");
  });

  it("numeric validator → MetaNumericValidator", () => {
    const { root } = load(
      JSON.stringify({
        metadata: {
          package: "demo",
          children: [
            {
              field: {
                package: "demo",
                name: "age",
                subType: "int",
                children: [
                  { validator: { subType: "numeric", "@min": 0, "@max": 150 } },
                ],
              },
            },
          ],
        },
      }),
    );
    const v = new MetaRoot(root).fields().find((f) => f.name === "age")!
      .validators()[0]!;
    expect(v).toBeInstanceOf(MetaNumericValidator);
    expect(v.min).toBe(0);
    expect(v.max).toBe(150);
  });

  it("array validator → MetaArrayValidator", () => {
    const { root } = load(
      JSON.stringify({
        metadata: {
          package: "demo",
          children: [
            {
              field: {
                package: "demo",
                name: "tags",
                subType: "string",
                "@isArray": true,
                children: [
                  { validator: { subType: "array", "@min": 1, "@max": 10 } },
                ],
              },
            },
          ],
        },
      }),
    );
    const v = new MetaRoot(root).fields().find((f) => f.name === "tags")!
      .validators()[0]!;
    expect(v).toBeInstanceOf(MetaArrayValidator);
    expect(v.min).toBe(1);
    expect(v.max).toBe(10);
  });
});

describe("metaOf factory dispatches to MetaLayout / MetaSource / MetaOrigin", () => {
  it("returns MetaLayout for layout/dataGrid node", () => {
    const loader = new Loader();
    const { root } = loader.loadJson(
      JSON.stringify({
        metadata: {
          package: "demo",
          children: [
            {
              object: {
                name: "Widget",
                subType: "entity",
                children: [
                  { field: { name: "id", subType: "long" } },
                  { identity: { subType: "primary", "@fields": "id" } },
                  {
                    layout: {
                      subType: "dataGrid",
                      name: "default",
                      "@pageSize": 25,
                      "@columns": ["id"],
                    },
                  },
                ],
              },
            },
          ],
        },
      }),
    );
    const widget = root.children().find((c) => c.name === "Widget")!;
    const layoutModel = widget.children().find((c) => c.type === TYPE_LAYOUT)!;
    expect(layoutModel).toBeDefined();
    const view = metaOf(layoutModel);
    expect(view).toBeInstanceOf(MetaLayout);
  });

  it("returns MetaSource for source/dbTable node", () => {
    const loader = new Loader();
    const { root } = loader.loadJson(
      JSON.stringify({
        metadata: {
          package: "demo",
          children: [
            {
              object: {
                name: "Product",
                subType: "entity",
                children: [
                  { source: { subType: "dbTable", "@name": "products" } },
                  { field: { name: "id", subType: "long" } },
                  { identity: { subType: "primary", "@fields": "id" } },
                ],
              },
            },
          ],
        },
      }),
    );
    const product = root.children().find((c) => c.name === "Product")!;
    const sourceModel = product.children().find((c) => c.type === TYPE_SOURCE)!;
    expect(sourceModel).toBeDefined();
    const view = metaOf(sourceModel);
    expect(view).toBeInstanceOf(MetaSource);
  });

  it("returns MetaOrigin for origin/passthrough node", () => {
    const loader = new Loader();
    const { root } = loader.loadJson(
      JSON.stringify({
        metadata: {
          package: "demo",
          children: [
            {
              object: {
                name: "Summary",
                subType: "entity",
                children: [
                  { source: { subType: "dbView", "@name": "v_summary" } },
                  {
                    field: {
                      name: "label",
                      subType: "string",
                      children: [
                        {
                          origin: {
                            subType: "passthrough",
                            "@from": "Base.label",
                          },
                        },
                      ],
                    },
                  },
                  { identity: { subType: "primary", "@fields": "label" } },
                ],
              },
            },
          ],
        },
      }),
    );
    const summary = root.children().find((c) => c.name === "Summary")!;
    const labelField = summary.children().find((c) => c.name === "label")!;
    const originModel = labelField
      .children()
      .find((c) => c.type === TYPE_ORIGIN)!;
    expect(originModel).toBeDefined();
    const view = metaOf(originModel);
    expect(view).toBeInstanceOf(MetaOrigin);
  });
});

describe("MetaObject typed views — Java parity for extends inheritance", () => {
  it("MetaObject.fields() returns inherited + own fields", () => {
    const json = JSON.stringify({
      metadata: {
        package: "acme",
        children: [
          {
            object: {
              name: "BaseEntity",
              subType: "entity",
              isAbstract: true,
              children: [
                { field: { name: "id", subType: "long" } },
                { field: { name: "createdAt", subType: "string" } },
              ],
            },
          },
          {
            object: {
              name: "Subscriber",
              subType: "entity",
              extends: "BaseEntity",
              children: [
                { field: { name: "email", subType: "string" } },
                { identity: { subType: "primary", "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    const { root, errors } = load(json);
    expect(errors).toEqual([]);
    const subscriber = root.children().find((c) => c.name === "Subscriber")!;
    const view = metaOf(subscriber) as MetaObject;
    const fieldNames = view.fields().map((f) => f.name);
    expect(fieldNames).toContain("id");        // inherited
    expect(fieldNames).toContain("createdAt"); // inherited
    expect(fieldNames).toContain("email");     // own
  });

  it("MetaObject.findField walks super chain", () => {
    const json = JSON.stringify({
      metadata: {
        package: "acme",
        children: [
          {
            object: {
              name: "BaseEntity",
              subType: "entity",
              isAbstract: true,
              children: [{ field: { name: "id", subType: "long" } }],
            },
          },
          {
            object: {
              name: "Subscriber",
              subType: "entity",
              extends: "BaseEntity",
              children: [
                { field: { name: "email", subType: "string" } },
                { identity: { subType: "primary", "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    const { root } = load(json);
    const subscriber = root.children().find((c) => c.name === "Subscriber")!;
    const view = metaOf(subscriber) as MetaObject;
    expect(view.findField("id")?.name).toBe("id");       // inherited
    expect(view.findField("email")?.name).toBe("email"); // own
    expect(view.findField("notARealField")).toBeUndefined();
  });

  it("MetaObject.identities() returns inherited + own identities", () => {
    const json = JSON.stringify({
      metadata: {
        package: "acme",
        children: [
          {
            object: {
              name: "BaseEntity",
              subType: "entity",
              isAbstract: true,
              children: [
                { field: { name: "id", subType: "long" } },
                { identity: { subType: "primary", "@fields": "id" } },
              ],
            },
          },
          {
            object: {
              name: "Subscriber",
              subType: "entity",
              extends: "BaseEntity",
              children: [
                { field: { name: "email", subType: "string" } },
                {
                  identity: {
                    subType: "secondary",
                    name: "byEmail",
                    "@fields": "email",
                  },
                },
              ],
            },
          },
        ],
      },
    });
    const { root, errors } = load(json);
    expect(errors).toEqual([]);
    const subscriber = root.children().find((c) => c.name === "Subscriber")!;
    const view = metaOf(subscriber) as MetaObject;
    const ids = view.identities();
    expect(ids.length).toBe(2); // primary (inherited) + secondary (own)
    expect(view.primaryIdentity()?.attr("fields")).toBe("id");
    expect(view.secondaryIdentities().length).toBe(1);
  });
});

describe("MetaField.resolveSuper", () => {
  it("returns the typed supertype field when extends: resolves", () => {
    const { root } = load(
      JSON.stringify({
        metadata: {
          package: "demo",
          children: [
            {
              field: {
                package: "demo::common",
                name: "id",
                subType: "long",
                "@isAbstract": true,
              },
            },
            {
              object: {
                name: "Widget",
                subType: "entity",
                children: [
                  { field: { name: "id", extends: "::demo::common::id" } },
                  {
                    identity: {
                      name: "pk",
                      subType: "primary",
                      "@fields": ["id"],
                      "@generation": "increment",
                    },
                  },
                ],
              },
            },
          ],
        },
      }),
    );
    const widget = new MetaRoot(root).findObject("Widget")!;
    const idField = widget.findField("id")!;
    const sup = idField.resolveSuper();
    expect(sup).toBeInstanceOf(MetaField);
    expect(sup!.subType).toBe("long");
    expect(sup!.isAbstract).toBe(true);
  });

  it("returns undefined when there's no super ref", () => {
    const { root } = load(SAMPLE);
    const id = new MetaRoot(root).findObject("User")!.findField("id")!;
    expect(id.resolveSuper()).toBeUndefined();
  });
});
