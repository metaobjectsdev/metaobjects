/**
 * The hand-written part: rules the metadata cannot state.
 *
 * This is the one place in the example that is written against GENERATED code. The grid,
 * the form and the routes read the loaded metadata and never mention an entity; a business
 * rule is the opposite, it is about specific entities and specific fields, so it is typed
 * against the generated interfaces and name constants (src/generated/). Rename `status` or
 * drop the `done` member in the metadata, run `meta gen`, and this file stops compiling,
 * which is the check the dynamic layers cannot give you.
 */
import type { Part } from "../generated/Part";
import { PartNames } from "../generated/Part.names";
import type { WorkOrder, WorkOrderStatus } from "../generated/WorkOrder";
import { WorkOrderNames } from "../generated/WorkOrder.names";
import type { WorkOrderLine } from "../generated/WorkOrderLine";
import { WorkOrderLineNames } from "../generated/WorkOrderLine.names";
import type { WriteIssue, WriteRule } from "./routes";

const DONE: WorkOrderStatus = "done";
const RULE_DONE_NEEDS_TECHNICIAN = "work_order.done_needs_technician";
const RULE_PART_DISCONTINUED = "work_order_line.part_discontinued";
const RULE_INSUFFICIENT_STOCK = "work_order_line.insufficient_stock";

/** A work order cannot be closed by nobody: `done` needs a technician on it. */
export const doneNeedsTechnician: WriteRule = ({ entity, next }) => {
  if (entity !== WorkOrderNames.name) return [];
  // ObjectManager rows are untyped; the generated interface is what gives them a shape.
  const order = next as Partial<WorkOrder>;
  if (order.status !== DONE || (order.technicianId !== undefined && order.technicianId !== null)) return [];
  return [
    {
      path: [WorkOrderNames.fields.technicianId.name],
      code: RULE_DONE_NEEDS_TECHNICIAN,
      message: "Assign a technician before marking the work order done.",
    },
  ];
};

/** A line may only take a part that is still sold, and no more of it than is in stock. */
export const lineTakesAvailableStock: WriteRule = async ({ entity, next, om }) => {
  if (entity !== WorkOrderLineNames.name) return [];
  const line = next as Partial<WorkOrderLine>;
  if (line.partId === undefined) return [];
  const part = (await om.findById(PartNames.name, line.partId)) as Part | null;
  // No such part is the database's to refuse (the foreign key), not this rule's.
  if (part === null) return [];
  const issues: WriteIssue[] = [];
  if (part.discontinued) {
    issues.push({
      path: [WorkOrderLineNames.fields.partId.name],
      code: RULE_PART_DISCONTINUED,
      message: `${part.sku} is discontinued and cannot be added to a work order.`,
    });
  }
  const quantity = line.quantity ?? 1;
  if (quantity > part.stockQty) {
    issues.push({
      path: [WorkOrderLineNames.fields.quantity.name],
      code: RULE_INSUFFICIENT_STOCK,
      message: `Only ${part.stockQty} of ${part.sku} in stock.`,
    });
  }
  return issues;
};

export const businessRules: readonly WriteRule[] = [doneNeedsTechnician, lineTakesAvailableStock];
