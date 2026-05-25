export interface NpcPromptPayload {
  name: string;
  mood: string;
}

import { render, type Provider } from "@metaobjectsdev/render";

export function renderNpcTurn(payload: NpcPromptPayload, provider: Provider): string {
  return render({ ref: "npc/turn", payload, format: "xml", provider });
}
