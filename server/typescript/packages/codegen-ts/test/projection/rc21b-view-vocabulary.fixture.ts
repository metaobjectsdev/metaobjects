// rc.21 part B: the shared model of the view-vocabulary tests (golden SQL and live Postgres).
export const RC21B_ENTITIES: unknown[] = [
  { "object.entity": { name: "Region", children: [
    { "source.rdb": { "@table": "regions" } },
    { "field.long": { name: "id" } },
    { "field.string": { name: "code" } },
    { "identity.primary": { name: "id", "@fields": "id" } },
  ] } },
  { "object.value": { name: "Contact", children: [
    { "field.string": { name: "kind" } },
    { "field.string": { name: "value" } },
    { "field.boolean": { name: "preferred" } },
    { "field.int": { name: "rank" } },
  ] } },
  { "object.entity": { name: "Customer", children: [
    { "source.rdb": { "@table": "customers" } },
    { "field.long": { name: "id" } },
    { "field.string": { name: "firstName" } },
    { "field.string": { name: "lastName" } },
    { "field.string": { name: "zip" } },
    { "field.long": { name: "regionId" } },
    { "field.long": { name: "defaultWarehouseId" } },
    { "field.object": { name: "contacts", "@objectRef": "Contact", isArray: true, "@storage": "jsonb" } },
    { "identity.primary": { name: "id", "@fields": "id" } },
    { "identity.reference": { name: "regionId", "@fields": "regionId", "@references": "Region" } },
    { "field.string": { name: "loyaltyTier", children: [
      { "origin.function": { "@function": "loyalty_tier", "@schema": "app", "@args": ["id", "zip"], "@params": ["long", "string"], "@returns": "string" } } ] } },
  ] } },
  { "object.entity": { name: "Address", children: [
    { "source.rdb": { "@table": "addresses" } },
    { "field.long": { name: "id" } },
    { "field.long": { name: "customerId" } },
    { "field.string": { name: "street" } },
    { "identity.primary": { name: "id", "@fields": "id" } },
    { "identity.reference": { name: "customerId", "@fields": "customerId", "@references": "Customer" } },
  ] } },
  { "object.entity": { name: "Order", children: [
    { "source.rdb": { "@table": "orders" } },
    { "field.long": { name: "id" } },
    { "field.long": { name: "customerId" } },
    { "field.enum": { name: "status", "@values": ["Open", "Shipped"], "@intValueMap": { Open: 0, Shipped: 1 } } },
    { "field.int": { name: "stage" } },
    { "field.string": { name: "externalRef" } },
    { "field.timestamp": { name: "updatedAt" } },
    { "identity.primary": { name: "id", "@fields": "id" } },
    { "identity.reference": { name: "customerId", "@fields": "customerId", "@references": "Customer" } },
  ] } },
  { "object.entity": { name: "OrderEvent", children: [
    { "source.rdb": { "@table": "order_events" } },
    { "field.long": { name: "id" } },
    { "field.long": { name: "orderId", "@required": true } },
    { "field.long": { name: "customerId" } },
    { "field.int": { name: "stage" } },
    { "field.timestamp": { name: "createdAt" } },
    { "identity.primary": { name: "id", "@fields": "id" } },
    { "identity.reference": { name: "orderId", "@fields": "orderId", "@references": "Order" } },
  ] } },
];

/** The same model without the origin.function field (SQLite has no stored functions). */
export function withoutFunction(entities: unknown[]): unknown[] {
  const clone = JSON.parse(JSON.stringify(entities)) as Record<string, { children?: Record<string, { name?: string }>[] }>[];
  for (const e of clone) {
    const ent = e["object.entity"];
    if (ent?.children) ent.children = ent.children.filter((c) => c["field.string"]?.name !== "loyaltyTier");
  }
  return clone;
}
