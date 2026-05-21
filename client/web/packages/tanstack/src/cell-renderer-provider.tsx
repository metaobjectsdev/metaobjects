import { createContext, useContext, useMemo, type ReactNode } from "react";
import { defaultCellRenderers, type CellRenderer } from "./cell-renderers.js";

const CellRendererContext = createContext<Record<string, CellRenderer>>(defaultCellRenderers);

export interface CellRendererProviderProps {
  /** Overrides merged on top of the inherited renderers. */
  value: Partial<Record<string, CellRenderer>>;
  children: ReactNode;
}

export function CellRendererProvider({ value, children }: CellRendererProviderProps) {
  const inherited = useContext(CellRendererContext);
  const merged = useMemo(() => ({ ...inherited, ...value }), [inherited, value]) as Record<string, CellRenderer>;
  return <CellRendererContext.Provider value={merged}>{children}</CellRendererContext.Provider>;
}

export function useCellRenderers(): Record<string, CellRenderer> {
  return useContext(CellRendererContext);
}
