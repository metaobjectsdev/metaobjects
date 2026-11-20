/**
 * Demo rows, written through ObjectManager. Typed against the generated interfaces, so a
 * row that no longer fits the model fails `tsc` instead of failing at startup.
 */
import type { ObjectManager, Row } from "@metaobjectsdev/runtime-ts";
import type { Customer } from "../generated/Customer";
import { CustomerNames } from "../generated/Customer.names";
import type { Part } from "../generated/Part";
import { PartNames } from "../generated/Part.names";
import type { Technician } from "../generated/Technician";
import { TechnicianNames } from "../generated/Technician.names";
import type { WorkOrder } from "../generated/WorkOrder";
import { WorkOrderNames } from "../generated/WorkOrder.names";
import type { WorkOrderLine } from "../generated/WorkOrderLine";
import { WorkOrderLineNames } from "../generated/WorkOrderLine.names";

const CUSTOMERS: readonly Customer[] = [
  { name: "Harbor Bakery", email: "ops@harborbakery.example", tier: "gold", active: true, billingAddress: { street: "12 Quay Street", city: "Portside", postalCode: "04101" } },
  { name: "Lakeside Cycles", email: "hello@lakesidecycles.example", tier: "standard", active: true, billingAddress: { street: "88 Shore Road", city: "Lakeside" } },
  { name: "Northgate Print", tier: "platinum", active: true, billingAddress: { street: "3 Mill Lane", city: "Northgate", postalCode: "03301" } },
  { name: "Old Mill Cafe", email: "owner@oldmill.example", tier: "standard", active: false },
];

const TECHNICIANS: readonly Technician[] = [
  { name: "Ada Okafor", level: "master", hourlyRate: "92.50", hiredOn: "2015-03-02" },
  { name: "Ben Ruiz", level: "journeyman", hourlyRate: "64.00", hiredOn: "2020-09-14" },
  { name: "Cleo Lindqvist", level: "apprentice", hourlyRate: "38.75", hiredOn: "2025-01-06" },
];

const PARTS: readonly Part[] = [
  { sku: "BLT-M8-40", name: "M8 x 40 bolt", unitPriceCents: 45, stockQty: 1200, discontinued: false },
  { sku: "BRG-6204", name: "6204 sealed bearing", unitPriceCents: 1295, stockQty: 64, discontinued: false },
  { sku: "FLT-OIL-22", name: "Oil filter, 22 mm", unitPriceCents: 1850, stockQty: 31, discontinued: false },
  { sku: "GSK-HD-07", name: "Head gasket, series 7", unitPriceCents: 7400, stockQty: 6, discontinued: false },
  { sku: "PMP-W-110", name: "Water pump, 110 V", unitPriceCents: 21900, stockQty: 3, discontinued: false },
  { sku: "RLY-12V-A", name: "12 V relay, type A", unitPriceCents: 990, stockQty: 0, discontinued: true },
];

/** Work orders name their customer and technician by position in the lists above. */
const WORK_ORDERS: readonly (Omit<WorkOrder, "customerId" | "technicianId"> & { customer: number; technician?: number })[] = [
  { title: "Replace oven conveyor bearing", status: "in_progress", priority: "urgent", customer: 0, technician: 0, estimatedHours: "3.50", dueOn: "2026-11-24" },
  { title: "Quarterly mixer service", status: "open", priority: "normal", customer: 0, estimatedHours: "2.00", dueOn: "2026-12-05" },
  { title: "Wheel truing stand recalibration", status: "done", priority: "low", customer: 1, technician: 1, estimatedHours: "1.25", dueOn: "2026-11-10" },
  { title: "Compressor will not hold pressure", status: "blocked", priority: "urgent", customer: 1, technician: 1, estimatedHours: "4.00", dueOn: "2026-11-21", notes: "Waiting on a head gasket from the supplier." },
  { title: "Press feed motor replacement", status: "open", priority: "normal", customer: 2, technician: 0, estimatedHours: "6.75", dueOn: "2026-12-12" },
  { title: "Cutter blade alignment", status: "done", priority: "normal", customer: 2, technician: 2, estimatedHours: "0.75", dueOn: "2026-11-03" },
  { title: "Espresso boiler descale", status: "open", priority: "low", customer: 3, dueOn: "2026-12-19" },
  { title: "Annual safety inspection", status: "open", priority: "normal", customer: 2, estimatedHours: "2.50", dueOn: "2027-01-15" },
  { title: "Dough sheeter belt swap", status: "in_progress", priority: "normal", customer: 0, technician: 2, estimatedHours: "1.50", dueOn: "2026-11-27" },
  { title: "Water pump failure", status: "open", priority: "urgent", customer: 1, estimatedHours: "3.00", dueOn: "2026-11-22" },
  { title: "Paper jam sensor fault", status: "done", priority: "low", customer: 2, technician: 1, estimatedHours: "0.50", dueOn: "2026-10-29" },
  { title: "Proofing cabinet thermostat", status: "open", priority: "normal", customer: 0, estimatedHours: "1.00", dueOn: "2026-12-01" },
];

/** Lines name their work order and part by position. */
const LINES: readonly (Pick<WorkOrderLine, "quantity"> & { order: number; part: number })[] = [
  { order: 0, part: 1, quantity: 2 },
  { order: 0, part: 0, quantity: 8 },
  { order: 3, part: 3, quantity: 1 },
  { order: 4, part: 0, quantity: 12 },
  { order: 8, part: 2, quantity: 1 },
  { order: 9, part: 4, quantity: 1 },
];

function idOf(row: Row): number {
  const id = row["id"];
  if (typeof id !== "number") throw new Error("a seeded row came back without a numeric id");
  return id;
}

async function createAll(om: ObjectManager, entity: string, rows: readonly object[]): Promise<number[]> {
  const ids: number[] = [];
  for (const row of rows) ids.push(idOf(await om.create(entity, { ...row })));
  return ids;
}

function at(ids: readonly number[], index: number): number {
  const id = ids[index];
  if (id === undefined) throw new Error(`seed data names row ${index}, which does not exist`);
  return id;
}

export async function seed(om: ObjectManager): Promise<void> {
  const customers = await createAll(om, CustomerNames.name, CUSTOMERS);
  const technicians = await createAll(om, TechnicianNames.name, TECHNICIANS);
  const parts = await createAll(om, PartNames.name, PARTS);
  const orders = await createAll(
    om,
    WorkOrderNames.name,
    WORK_ORDERS.map(({ customer, technician, ...order }): WorkOrder => ({
      ...order,
      customerId: at(customers, customer),
      ...(technician !== undefined ? { technicianId: at(technicians, technician) } : {}),
    })),
  );
  await createAll(
    om,
    WorkOrderLineNames.name,
    LINES.map(({ order, part, quantity }): WorkOrderLine => ({
      workOrderId: at(orders, order),
      partId: at(parts, part),
      quantity,
    })),
  );
}
