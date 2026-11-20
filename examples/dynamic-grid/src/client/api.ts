/**
 * Transport, and the two things every component does with a server answer: read a
 * refusal's body, and turn a `validation` 400 into messages keyed by field.
 */
import type { EntityFetcher } from "@metaobjectsdev/runtime-web";
import { SERVED_ROUTE_PATH, type ServedInfo } from "../served";
import { buildClientModel, isRecord, type ClientModel } from "./model";

/** A plain row, as the API returns it. */
export type Row = Record<string, unknown>;

/** The server said no. `body` is its JSON answer, e.g. `{ error: "validation", issues: [...] }`. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`The server answered ${status}: ${JSON.stringify(body)}`);
    this.name = "ApiError";
  }
}

/** `fetch`, as JSON, throwing `ApiError` for any answer that is not a success. */
export const jsonFetcher: EntityFetcher = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, {
    ...init,
    headers: { ...(init?.body !== undefined ? { "content-type": "application/json" } : {}), ...init?.headers },
  });
  const text = await response.text();
  const body: unknown = text === "" ? undefined : JSON.parse(text);
  if (!response.ok) throw new ApiError(response.status, body);
  return body as T;
};

const META_ROUTE_PATH = "/_meta";

/** Fetch the model document and where it is served, and build the browser model from them. */
export async function loadClientModel(fetcher: EntityFetcher): Promise<ClientModel> {
  const [document, served] = await Promise.all([fetcher<unknown>(META_ROUTE_PATH), fetcher<ServedInfo>(SERVED_ROUTE_PATH)]);
  return buildClientModel(document, served);
}

export async function servedRevision(fetcher: EntityFetcher): Promise<number> {
  return (await fetcher<ServedInfo>(SERVED_ROUTE_PATH)).revision;
}

/** One line a person can read, for a refusal that is not about a particular field. */
export function describeError(error: unknown): string {
  if (!(error instanceof ApiError)) return error instanceof Error ? error.message : String(error);
  const body = error.body;
  if (!isRecord(body)) return `The server answered ${error.status}.`;
  const allowed = Array.isArray(body["allowed"]) ? ` Allowed: ${body["allowed"].join(", ")}.` : "";
  const detail = Object.entries(body)
    .filter(([key, value]) => key !== "error" && key !== "allowed" && key !== "issues" && typeof value !== "object")
    .map(([key, value]) => `${key} ${String(value)}`)
    .join(", ");
  return `${String(body["error"])}${detail === "" ? "" : ` (${detail})`}.${allowed}`;
}

/**
 * The issues of a `validation` 400, by field path (`quantity`, `billingAddress.city`), or
 * undefined when the error is something else.
 */
export function validationIssues(error: unknown): Map<string, string> | undefined {
  if (!(error instanceof ApiError) || !isRecord(error.body) || !Array.isArray(error.body["issues"])) return undefined;
  const byPath = new Map<string, string>();
  for (const issue of error.body["issues"]) {
    if (!isRecord(issue)) continue;
    const path = Array.isArray(issue["path"]) ? issue["path"].join(".") : "";
    if (!byPath.has(path)) byPath.set(path, String(issue["message"]));
  }
  return byPath;
}
