// @metaobjectsdev/pack-delivery: what runs where, and what differs per environment
// (ADR-0069 independent pack). The vocabulary is metamodel/delivery.json; this module
// registers it and checks the references the data cannot: a deployment's @app and
// @environment, and a value.ref's @producedBy.
//
// The pack registers `deployment.base` and no concrete deployment: the platform is the
// subtype, and a platform pack registers it (`deployment.<platform>`, `extendsBase: true`).
// Such a pack passes `validateDeployment` as that subtype's validator, so its
// deployments are held to the same references.

import {
  applyProviderDefinition,
  topLevelNodeOf,
  type MetaData,
  type MetaDataTypeProvider,
  type NodeValidator,
  type ProviderDefinition,
  type TypeRegistry,
  type ValidationContext,
} from "@metaobjectsdev/metadata";
import { SYSTEMS_PROVIDER_ID, TYPE_APP, TYPE_RESOURCE, checkRefs, packTypeMaps, refList, resolveSystemRef } from "@metaobjectsdev/pack-systems";
import definition from "../../metamodel/delivery.json" with { type: "json" };
import {
  DELIVERY_PROVIDER_ID,
  DEPLOYMENT_ATTR_APP,
  DEPLOYMENT_ATTR_ENVIRONMENT,
  ERR_DELIVERY_DUPLICATE_DEPLOYMENT,
  ERR_DELIVERY_DUPLICATE_SETTING,
  ERR_DELIVERY_UNRESOLVED_REF,
  TYPE_BUILD,
  TYPE_DEPLOYMENT,
  TYPE_ENVIRONMENT,
  TYPE_VALUE,
  VALUE_ATTR_PRODUCED_BY,
  VALUE_ATTR_SETTING,
} from "./constants.js";

export * from "./constants.js";

export const DELIVERY_DEFINITION = definition as ProviderDefinition;

// The (app, environment) a deployment targets, as resolved nodes, so `Game.server` and
// `acme::game::Game.server` are the same app. Undefined when either does not resolve (the
// reference check reports that).
function deploymentTarget(node: MetaData): [MetaData, MetaData] | undefined {
  const app = refList(node, DEPLOYMENT_ATTR_APP)[0];
  const env = refList(node, DEPLOYMENT_ATTR_ENVIRONMENT)[0];
  if (app === undefined || env === undefined) return undefined;
  const a = resolveSystemRef(node, app, DEPLOYMENT_ATTR_APP, [TYPE_APP]);
  const e = resolveSystemRef(node, env, DEPLOYMENT_ATTR_ENVIRONMENT, [TYPE_ENVIRONMENT]);
  return a === undefined || e === undefined ? undefined : [a, e];
}

// An app runs once per environment: two deployments for one (app, environment) leave a
// generator to pick by load order. The error lands on the later one.
function checkDeploymentUnique(node: MetaData, ctx: ValidationContext): void {
  const mine = deploymentTarget(node);
  const root = topLevelNodeOf(node).parent;
  if (mine === undefined || root === undefined) return;
  // ADR-0039: resolving, the deployments the model effectively holds.
  const deployments = root.children().filter((c) => c.type === TYPE_DEPLOYMENT);
  const first = deployments.find((d) => {
    const t = deploymentTarget(d);
    return t !== undefined && t[0] === mine[0] && t[1] === mine[1];
  });
  if (first !== undefined && first !== node) {
    ctx.error(
      ERR_DELIVERY_DUPLICATE_DEPLOYMENT,
      node,
      `${node.type}.${node.subType} "${node.name}" deploys the same app in the same environment as "${first.name}": a model has at most one deployment per (@app, @environment).`,
    );
  }
}

/** The validator a platform pack attaches to its `deployment.<platform>` subtype. */
export const validateDeployment: NodeValidator = (node, ctx) => {
  checkRefs(node, DEPLOYMENT_ATTR_APP, [TYPE_APP], ERR_DELIVERY_UNRESOLVED_REF, ctx);
  checkRefs(node, DEPLOYMENT_ATTR_ENVIRONMENT, [TYPE_ENVIRONMENT], ERR_DELIVERY_UNRESOLVED_REF, ctx);
  checkDeploymentUnique(node, ctx);
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
// bound across build.* is checked here. The bound is on the app's effective builds: one it
// declares beside one it inherits through `extends` is two. The error lands on the declared
// build that makes the second: the later of two declared here, or one declared beside an
// inherited build.
const validateBuild: NodeValidator = (node, ctx) => {
  const app = node.parent;
  if (app === undefined) return;
  // ADR-0039: resolving, so a build inherited through `extends` counts.
  const others = app.children().filter((c) => c.type === TYPE_BUILD && c !== node);
  // ADR-0039: own: the builds this app declares, to find the first of them.
  const declared = app.ownChildren().filter((c) => c.type === TYPE_BUILD);
  const inherited = others.some((c) => !declared.includes(c));
  if (inherited || declared[0] !== node) {
    ctx.error(
      "ERR_TOO_MANY_OCCURRENCES",
      node,
      `${node.type}.${node.subType} "${node.name}" is a second build of ${app.type}.${app.subType} "${app.name}": an app has at most one build.`,
    );
  }
};

// A deployment sets each setting once. An estate overlay that overrides a value must reuse
// the value node's name so the overlay merges into it; a second, differently named value
// for the same @setting would sit beside the first, so it is an error. It lands on the later.
const validateValue: NodeValidator = (node, ctx) => {
  const setting = node.attr(VALUE_ATTR_SETTING);
  const deployment = node.parent;
  if (typeof setting === "string" && deployment !== undefined) {
    // ADR-0039: resolving, so a value a deployment inherits counts.
    const first = deployment.children().find((c) => c.type === TYPE_VALUE && c.attr(VALUE_ATTR_SETTING) === setting);
    if (first !== undefined && first !== node) {
      ctx.error(
        ERR_DELIVERY_DUPLICATE_SETTING,
        node,
        `${node.type}.${node.subType} "${node.name}" sets "${setting}", which "${first.name}" already sets in ${deployment.type}.${deployment.subType} "${deployment.name}". An estate overlay overriding a value has to reuse the value node's name so the overlay merges it; a second, differently named value for the same @setting is an error.`,
      );
    }
  }
  checkRefs(node, VALUE_ATTR_PRODUCED_BY, [TYPE_RESOURCE, TYPE_APP], ERR_DELIVERY_UNRESOLVED_REF, ctx);
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
