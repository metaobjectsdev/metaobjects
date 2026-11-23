// A model with application-owned top-level vocabulary, as an adopter with its own providers
// exports it: an entity and a page of a custom type sharing a package and a name, and a
// requirement claiming a node of a custom type. Both shapes broke the explorer: the first
// threw on a duplicate id, the second left a link with no page behind it.
//
// The explorer reads canonical JSON and never the loader, so the custom types (`page.list`,
// `capability.module`) need no provider here.

export const CUSTOM_VOCABULARY_MODEL = {
  "metadata.root": {
    children: [
      {
        "page.list": {
          name: "Lead",
          package: "acme::crm",
          "@entity": "acme::crm::Lead",
          children: [{ "block.table": { name: "leads", "@entity": "acme::crm::Lead" } }],
        },
      },
      {
        "object.entity": {
          name: "Lead",
          package: "acme::crm",
          "@description": "A prospective customer.",
          children: [
            { "field.long": { name: "id" } },
            { "field.string": { name: "email" } },
          ],
        },
      },
      { "capability.module": { name: "tax", package: "acme::tax", "@description": "Sales tax." } },
      {
        "requirement.functional": {
          name: "Tax",
          package: "acme::tax",
          "@level": 1,
          "@status": "live",
          "@statement": "The software computes sales tax.",
          "@implementedBy": ["acme::tax::tax"],
        },
      },
    ],
  },
};

export const CUSTOM_VOCABULARY_VERIFY = {
  requirementLedger: [
    {
      path: "Tax",
      package: "acme::tax",
      qualifiedPath: "acme::tax::Tax",
      subType: "functional",
      level: 1,
      status: "live",
      digest: "",
      implementedBy: [{ ref: "acme::tax::tax", resolves: true, target: "acme::tax::tax" }],
      diagnostics: [],
      verdict: "clean",
    },
  ],
};
