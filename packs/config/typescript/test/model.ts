// A small model that uses everything the pack registers, loaded with the pack composed.
import { MetaDataLoader, InMemoryStringSource, composeRegistry, coreProviders, type MetaRoot } from "@metaobjectsdev/metadata";
import { configProvider } from "../src/index.js";

export const MODEL = {
  "metadata.root": {
    package: "acme::app",
    children: [
      {
        "object.entity": {
          name: "Customer",
          children: [
            { "source.rdb": { "@table": "customers" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "email" } },
            { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
          ],
        },
      },
      {
        "object.settings": {
          name: "Database",
          "@description": "The primary database.",
          children: [
            { "field.string": { name: "url", "@required": true, "@secret": true, "@description": "Connection URL." } },
            { "field.string": { name: "username", "@required": true } },
            { "field.int": { name: "poolSize", "@default": 10, "@envName": "DB_POOL_SIZE" } },
          ],
        },
      },
      {
        "object.settings": {
          name: "LlmProvider",
          children: [
            { "field.string": { name: "apiKey", "@required": true, "@secret": true } },
            { "field.string": { name: "model", "@default": "a model name" } },
            { "field.boolean": { name: "trace", "@default": false } },
          ],
        },
      },
      {
        "object.settings": {
          name: "Build",
          children: [{ "field.string": { name: "commitSha", "@phase": "build" } }],
        },
      },
      {
        "vault.infisical": {
          name: "keys",
          "@defaultScope": "dev",
          children: [
            { "scope.env": { name: "dev", "@project": "acme-app" } },
            { "scope.env": { name: "production", "@project": "acme-app-prod", "@env": "prod" } },
          ],
        },
      },
    ],
  },
};

export async function loadModel(model: unknown = MODEL): Promise<MetaRoot> {
  const registry = composeRegistry([...coreProviders, configProvider]);
  const res = await new MetaDataLoader({ registry, strict: true }).load([
    new InMemoryStringSource(JSON.stringify(model), { id: "meta.app.json", format: "json" }),
  ]);
  if (res.errors.length > 0) throw new Error(res.errors.map((e) => e.message).join("\n"));
  return res.root;
}
