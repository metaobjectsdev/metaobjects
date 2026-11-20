/**
 * The loaded model, for every component below it. `<MetaGrid entity="WorkOrder" />` gets
 * its entity from here by name; the name is the only thing a caller passes.
 */
import { createContext, useContext, type ReactNode } from "react";
import type { ClientModel, EntityModel } from "./model";

const ModelContext = createContext<ClientModel | null>(null);

export function ModelProvider({ model, children }: { model: ClientModel; children: ReactNode }): ReactNode {
  return <ModelContext.Provider value={model}>{children}</ModelContext.Provider>;
}

export function useModel(): ClientModel {
  const model = useContext(ModelContext);
  if (model === null) throw new Error("useModel() was called outside <ModelProvider>.");
  return model;
}

/** The named entity, or a thrown error: a name the model does not serve is a bug to surface. */
export function useEntity(name: string): EntityModel {
  const model = useModel();
  const entity = model.entity(name);
  if (entity === undefined) {
    throw new Error(`The model serves no entity "${name}" (it serves: ${model.entities.map((e) => e.name).join(", ")}).`);
  }
  return entity;
}
