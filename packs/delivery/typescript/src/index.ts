// @metaobjectsdev/pack-delivery: what runs where, and what differs per environment
// (ADR-0069 independent pack). The vocabulary is metamodel/delivery.json; this module
// registers it and checks the references the data cannot: a deployment's @app and
// @environment, and a value.ref's @from.
//
// The pack registers `deployment.base` and no concrete deployment: the platform is the
// subtype, and a platform pack registers it (`deployment.<platform>`, `extendsBase: true`).
// Such a pack passes `validateDeployment` as that subtype's validator, so its
// deployments are held to the same references.

import {
  applyProviderDefinition,
  type MetaDataTypeProvider,
  type NodeValidator,
  type ProviderDefinition,
  type TypeRegistry,
} from "@metaobjectsdev/metadata";
import { SYSTEMS_PROVIDER_ID, TYPE_APP, TYPE_RESOURCE, checkRefs, packTypeMaps } from "@metaobjectsdev/pack-systems";
import definition from "../../metamodel/delivery.json" with { type: "json" };
import {
  DELIVERY_PROVIDER_ID,
  DEPLOYMENT_ATTR_APP,
  DEPLOYMENT_ATTR_ENVIRONMENT,
  ERR_DELIVERY_UNRESOLVED_REF,
  TYPE_BUILD,
  TYPE_DEPLOYMENT,
  TYPE_ENVIRONMENT,
  TYPE_VALUE,
  VALUE_ATTR_FROM,
} from "./constants.js";

export * from "./constants.js";

export const DELIVERY_DEFINITION = definition as ProviderDefinition;

/** The validator a platform pack attaches to its `deployment.<platform>` subtype. */
export const validateDeployment: NodeValidator = (node, ctx) => {
  const error = ctx.error.bind(ctx);
  checkRefs(node, DEPLOYMENT_ATTR_APP, [TYPE_APP], ERR_DELIVERY_UNRESOLVED_REF, error);
  checkRefs(node, DEPLOYMENT_ATTR_ENVIRONMENT, [TYPE_ENVIRONMENT], ERR_DELIVERY_UNRESOLVED_REF, error);
};

// `deployment.base` is abstract, but the parser treats a `<type>.base` as abstract only
// once a concrete sibling is registered, and none is until a platform pack is composed.
// Refuse it here too, with the parser's code, so it never loads either way.
const refuseAbstractDeployment: NodeValidator = (node, ctx) => {
  ctx.error(
    "ERR_ABSTRACT_SUBTYPE_AUTHORED",
    node,
    `deployment.base "${node.name}" is abstract: declare the platform's own subtype (deployment.<platform>), which a platform pack registers.`,
  );
};

// An app has at most one build. The registry enforces a child rule's upper bound only per
// subtype (`maxOccurs`), and a dockerfile beside a build command is two subtypes, so the
// bound across build.* is checked here, on every build after the first.
const validateBuild: NodeValidator = (node, ctx) => {
  // ADR-0039: own: the bound is on what this app declares; an inherited build was counted where it was declared.
  const builds = node.parent?.ownChildren().filter((c) => c.type === TYPE_BUILD) ?? [];
  if (builds.length > 1 && builds[0] !== node) {
    ctx.error(
      "ERR_TOO_MANY_OCCURRENCES",
      node,
      `${node.type}.${node.subType} "${node.name}" is a second build of ${node.parent?.type}.${node.parent?.subType} "${node.parent?.name}": an app has at most one build.`,
    );
  }
};

const validateValue: NodeValidator = (node, ctx) => {
  checkRefs(node, VALUE_ATTR_FROM, [TYPE_RESOURCE, TYPE_APP], ERR_DELIVERY_UNRESOLVED_REF, ctx.error.bind(ctx));
};

export const provider: MetaDataTypeProvider = {
  id: DELIVERY_PROVIDER_ID,
  dependencies: ["metaobjects-core-types", SYSTEMS_PROVIDER_ID],
  description:
    "Delivery: environment.*, build.*, runtime.process, deployment.base (a platform pack adds the concrete subtype) and value.literal / value.ref.",
  registerTypes(registry: TypeRegistry): void {
    const { factories, validators } = packTypeMaps(DELIVERY_DEFINITION, {
      [TYPE_BUILD]: validateBuild,
      [TYPE_VALUE]: validateValue,
      [TYPE_DEPLOYMENT]: refuseAbstractDeployment,
    });
    applyProviderDefinition(registry, DELIVERY_DEFINITION, factories, validators);
  },
};
