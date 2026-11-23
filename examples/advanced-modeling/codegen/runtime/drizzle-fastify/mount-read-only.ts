import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import { parseListQueryString } from "./list-query.js";
import { REPORT_MAX_ROWS, ReportTooLargeError, FilterParseError, type PageSize } from "./filter-parser.js";
import { ReportExportError, exportContentDisposition, renderExport, EXPORT_CONTENT_TYPES, type ReportExportSpec } from "./report-export.js";
import type { FilterAllowlist, SortAllowlist } from "./filter-allowlist.js";
import { contractErrorCode } from "./util.js";
import type { SqlDialect } from "../sql-dialect.js";
import { timestampWire } from "../timestamp-wire.js";
import { withWire, type WireOptions } from "../wire-format.js";
import { withContractErrorHandler } from "./route-error-handler.js";
import { InvalidIdError, readOnlyGet, readOnlyList, rawViewName, type ReadOnlySpec } from "../read-only-read.js";

// biome-ignore lint/suspicious/noExplicitAny: dynamic dispatch over user-supplied views
type AnyView = any;

export interface MountReadOnlyOptions extends WireOptions {
  readonly fastify: FastifyInstance;
  readonly path: string;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic Drizzle client
  readonly db: any;
  readonly view: AnyView;
  readonly filterAllowlist: FilterAllowlist;
  readonly sortAllowlist: SortAllowlist;
  readonly dialect: SqlDialect;
  /**
   * The column `GET /:id` addresses a row by: the KEY of that column in the Drizzle view
   * (the field name), not its physical name. Defaults to "id". For a view declared with
   * no columns (the raw-SQL path) it is the physical column name instead, because there
   * is no key to look up.
   *
   * A view that declares columns and has none under this key has no row to address, so
   * `GET /:id` answers `404 not_found` for every id.
   */
  readonly idColumn?: string;
  /**
   * Fastify route-level hooks applied to every route this mounts — the same option
   * `mountCrudRoutes` and `mountM2mRoute` take, and for the same reason:
   *   routeOptions: { preHandler: requireAuthHook }
   *
   * A projection is read-only, not public. It was the one mount helper of the three
   * without this, so a generated projection route could not carry a hook the way a
   * generated entity route could — an inconsistency, not a policy. (Guarding the whole
   * mount from an enclosing plugin scope works here too, and needs no option at all.)
   */
  readonly routeOptions?: RouteShorthandOptions;
  /**
   * False for an object with no single-column primary identity: an `object.report`, or
   * a keyless projection. Mounts the list route and the collection POST refusal only,
   * and no `/:id` route of any verb. Default true, which is today's behaviour.
   */
  readonly itemRoutes?: boolean;
  /** The noun in the 405 message, which is free prose. Default "projection". */
  readonly resource?: "projection" | "report";
  /**
   * A report list's row cap (`resource: "report"` only; ignored otherwise). With no `limit`
   * the route answers every row up to this many and refuses above it with
   * `400 { "error": "report_too_large", "maxRows": N }`; an explicit `limit` above it is
   * refused the same way. Default 10000, the same in every port.
   */
  readonly reportMaxRows?: number;
  /**
   * The list page size of a projection (`api.pagination` in `.metaobjects/config.json`; ignored
   * for a report, which has `reportMaxRows`, and for a raw view, which pages to at most 1000).
   * A list with no `limit` returns `defaultLimit` rows; a `limit` above `maxLimit` answers
   * `400 { "error": "limit_too_large", "maxLimit": N }`. Absent, a list with no `limit` returns
   * 50 rows (`DEFAULT_PAGE_LIMIT`) and there is no ceiling.
   */
  readonly pagination?: PageSize;
  /**
   * Report export (`resource: "report"` only; ignored otherwise). Present when the project wires
   * the `report-export` generator: `?format=csv|json|xml` then answers the list in that shape,
   * capped by `export.maxRows` (which replaces `reportMaxRows` whenever `format` is set).
   * Absent: `?format=` is ignored like any unknown parameter.
   */
  readonly export?: ReportExportSpec;
}

const rejectMutation = (resource: string) => async (
  request: { method: string },
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
) => {
  reply
    .code(405)
    .send({ error: "method_not_allowed", message: `${request.method} is not supported on a ${resource} (read-only).` });
};

export function mountReadOnlyCrudRoutes(opts: MountReadOnlyOptions): void {
  const { fastify, path, db, view, filterAllowlist, sortAllowlist, dialect } = opts;
  const idCol = opts.idColumn ?? "id";
  // Route-scoped contract error handler: an unexpected error answers
  // `500 { error: "internal" }` rather than Fastify's default (which echoes the SQL).
  const ro = withContractErrorHandler(opts.routeOptions);
  const reject = rejectMutation(opts.resource ?? "projection");
  const itemRoutes = opts.itemRoutes !== false;
  // A report answers every row up to a cap and refuses above it; every other mount pages as asked.
  const isReport = opts.resource === "report";
  const reportMaxRows = opts.reportMaxRows ?? REPORT_MAX_ROWS;
  const exportSpec = isReport ? opts.export : undefined;

  // The raw-SQL branch (a view with no declared columns) has nothing that names a timestamp.
  const raw = rawViewName(view) !== undefined;
  const toWire = raw ? (row: unknown) => row : withWire(timestampWire(view), opts);
  const spec: ReadOnlySpec = {
    filterAllowlist,
    sortAllowlist,
    dialect,
    idColumn: idCol,
    report: isReport,
    reportMaxRows,
    ...(opts.pagination === undefined ? {} : { pagination: opts.pagination }),
    ...(exportSpec === undefined ? {} : { export: exportSpec }),
  };

  // ── List ──────────────────────────────────────────────────────────────────
  fastify.get(path, ro, async (req, reply) => {
    try {
      const url = req.raw.url ?? "";
      const qIdx = url.indexOf("?");
      const page = await readOnlyList(db, view, parseListQueryString(qIdx >= 0 ? url.slice(qIdx + 1) : ""), spec);
      const rows = page.rows.map(toWire);
      if (exportSpec && page.format !== undefined) {
        // Render first: a writer that throws must not leave download headers on the 500.
        // A Buffer, not a string: Fastify appends "; charset=utf-8" to a string body's
        // application/json, and the contract pins the content type exactly.
        const body = Buffer.from(renderExport(exportSpec, page.format, rows as Record<string, unknown>[], page.total), "utf8");
        reply
          .header("content-disposition", exportContentDisposition(path, page.format))
          .header("content-type", EXPORT_CONTENT_TYPES[page.format]);
        return body;
      }
      return page.total === undefined ? rows : { rows, total: page.total };
    } catch (err) {
      if (err instanceof ReportTooLargeError) {
        reply.code(400).send({ error: "report_too_large", maxRows: err.maxRows });
        return;
      }
      if (err instanceof ReportExportError) {
        reply.code(err.status).send(err.body);
        return;
      }
      if (err instanceof FilterParseError) {
        // Spread the details so the cross-port-required `field` reaches the wire on a
        // projection route too (F20) — the writable mount already does this.
        reply.code(400).send({ error: contractErrorCode(err.code), message: err.message, ...(err.details ?? {}) });
        return;
      }
      throw err;
    }
  });

  // A keyless object (`itemRoutes: false`) has nothing to address by id: no `/:id` route
  // of any verb, so the framework's own 404 answers.
  if (itemRoutes) {
    // ── Get by ID ─────────────────────────────────────────────────────────────
    fastify.get(`${path}/:id`, ro, async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const row = await readOnlyGet(db, view, id, spec);
        return row ? toWire(row) : reply.code(404).send({ error: "not_found" });
      } catch (err) {
        if (err instanceof InvalidIdError) return reply.code(400).send({ error: "invalid_id" });
        throw err;
      }
    });
  }

  // ── Mutations explicitly rejected (405) ───────────────────────────────────
  // PUT is here because the WRITABLE mount serves it (an alias of PATCH), so a
  // projection must reject it the same way the other three are rejected. Omitting it
  // left `PUT /<collection>/:id` falling through to Fastify's 404 — telling a caller
  // the resource does not exist when it plainly does and answers GET.
  fastify.post(path, ro, reject);
  if (itemRoutes) {
    fastify.patch(`${path}/:id`, ro, reject);
    fastify.put(`${path}/:id`, ro, reject);
    fastify.delete(`${path}/:id`, ro, reject);
  }
}
