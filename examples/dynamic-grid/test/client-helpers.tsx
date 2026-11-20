import { render, type RenderResult } from "@testing-library/react";
import type { EntityFetcher } from "@metaobjectsdev/runtime-web";
import { EntityFetcherProvider } from "@metaobjectsdev/tanstack";
import type { FastifyInstance } from "fastify";
import type { ReactNode } from "react";
import { ApiError, loadClientModel } from "../src/client/api";
import { ModelProvider } from "../src/client/context";
import type { ClientModel } from "../src/client/model";
import { API_PREFIX } from "../src/server/app";

/** One request a component made. */
export interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

export interface Transport {
  readonly fetcher: EntityFetcher;
  /** Every request made through `fetcher`, oldest first. */
  readonly calls: Call[];
}

/**
 * A fetcher that calls the app in-process: the components under test talk to the real
 * routes, the real ObjectManager and a real SQLite database, with no port opened.
 */
export function inProcess(app: FastifyInstance): Transport {
  const calls: Call[] = [];
  const fetcher: EntityFetcher = async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const method = init?.method ?? "GET";
    const payload = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ method, path, body: payload === undefined ? undefined : JSON.parse(payload) });
    const res = await app.inject({
      method: method as "GET" | "POST" | "PATCH" | "DELETE",
      url: path,
      ...(payload !== undefined ? { payload, headers: { "content-type": "application/json" } } : {}),
    });
    const body: unknown = res.body === "" ? undefined : JSON.parse(res.body);
    if (res.statusCode >= 400) throw new ApiError(res.statusCode, body);
    return body as T;
  };
  return { fetcher, calls };
}

/** The model as the browser would load it from this app. */
export function clientModel(transport: Transport): Promise<ClientModel> {
  return loadClientModel((path, init) => transport.fetcher(`${API_PREFIX}${path}`, init));
}

/** Render `ui` inside the two providers every component needs: the transport and the loaded model. */
export async function mount(transport: Transport, ui: ReactNode): Promise<RenderResult & { model: ClientModel }> {
  const model = await clientModel(transport);
  // What is recorded from here on is what the component under test asked for.
  transport.calls.length = 0;
  const rendered = render(
    <EntityFetcherProvider fetcher={transport.fetcher} baseUrl={API_PREFIX}>
      <ModelProvider model={model}>{ui}</ModelProvider>
    </EntityFetcherProvider>,
  );
  return Object.assign(rendered, { model });
}

/** The text of every body row of the first table in `root`, a cell per entry. */
export function tableRows(root: HTMLElement): string[][] {
  return [...root.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent ?? ""));
}

export function headers(root: HTMLElement): string[] {
  // The sort arrow is part of the header cell's text; it is not part of the label.
  return [...root.querySelectorAll("thead th")].map((th) => (th.textContent ?? "").replace(/ [↑↓]$/, ""));
}

/** The header cell of a column, by its label: the element a person clicks to sort. */
export function header(root: HTMLElement, label: string): HTMLElement {
  const found = [...root.querySelectorAll<HTMLElement>("thead th")].find((th) => (th.textContent ?? "").replace(/ [↑↓]$/, "") === label);
  if (found === undefined) throw new Error(`no column headed "${label}"`);
  return found;
}
