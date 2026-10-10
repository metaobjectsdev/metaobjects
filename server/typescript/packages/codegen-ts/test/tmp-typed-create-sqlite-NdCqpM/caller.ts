import { createBrewer, insertPreservingBrewer } from "./Brewer.queries";
import { createCarrier, updateCarrierById } from "./Party.queries";
declare const db: Parameters<typeof createBrewer>[0];
declare const tphDb: Parameters<typeof createCarrier>[0];
export async function run(): Promise<void> {
  await createBrewer(db, { email: "cy@example.com" });
}
