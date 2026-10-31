import { z } from "zod";

export const Address = z.object({
  line1: z.string().min(1),
  city: z.string().min(1),
  postcode: z.string().optional(),
});
export type Address = z.infer<typeof Address>;

export const CreateCustomer = z.object({
  email: z.string().min(1).max(254),
  displayName: z.string().min(1).max(120),
  plan: z.enum(["free", "team", "enterprise"]).optional(),
  seats: z.number().int().optional(),
  address: Address.optional(),
  tags: z.array(z.string()),
});
export type CreateCustomer = z.infer<typeof CreateCustomer>;
