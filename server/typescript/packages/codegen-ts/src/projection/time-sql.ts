// Time-grain truncation (contract Table D) and relative-date values (Table E),
// rendered as SQL for the three view dialects. Pure string functions: the report
// DDL emitter supplies an already-quoted column reference and picks the dialect.
import {
  GRAIN_DAY, GRAIN_HOUR, GRAIN_MONTH, GRAIN_QUARTER, GRAIN_WEEK, GRAIN_YEAR,
  ISO_DURATION_RE,
  TIME_GRAINS,
  type TimeGrain,
} from "@metaobjectsdev/metadata";

export type ReportDialect = "postgres" | "sqlite" | "mysql";
/** Table D's three column kinds: `instant` is a `field.timestamp` (TIMESTAMPTZ),
 *  `naive` one with `@localTime: true`, `date` a `field.date`. */
export type ReportTemporal = "date" | "instant" | "naive";

export interface IsoDurationParts {
  readonly sign: "+" | "-";
  readonly years: number;
  readonly months: number;
  readonly weeks: number;
  readonly days: number;
  readonly hours: number;
  readonly minutes: number;
  readonly seconds: number;
  /** The duration text without its sign, e.g. "P7D". */
  readonly magnitude: string;
}

/** Leading integer of a capture such as `"12H"`; an absent group is 0. */
function component(group: string | undefined): number {
  return group === undefined ? 0 : Number.parseInt(group, 10);
}

/** Parse a signed ISO-8601 duration. Capture groups of `ISO_DURATION_RE`, in order:
 *  1 `nY`, 2 `nM` (months), 3 `nW`, 4 `nD`, 5 the whole `T…` block, 6 `nH`, 7 `nM`
 *  (minutes), 8 `nS`. */
export function parseIsoDuration(duration: string): IsoDurationParts {
  const m = ISO_DURATION_RE.exec(duration);
  if (m === null) throw new Error(`time-sql: "${duration}" is not an ISO-8601 duration.`);
  return {
    sign: duration.startsWith("-") ? "-" : "+",
    years: component(m[1]),
    months: component(m[2]),
    weeks: component(m[3]),
    days: component(m[4]),
    hours: component(m[6]),
    minutes: component(m[7]),
    seconds: component(m[8]),
    magnitude: duration.replace(/^[+-]/, ""),
  };
}

/** Table D. `ref` is an already-quoted `alias."column"` reference. */
export function truncateToGrain(
  ref: string,
  grain: TimeGrain,
  temporal: ReportTemporal,
  dialect: ReportDialect,
): string {
  // The Postgres arm writes the grain into `date_trunc('<grain>', ...)`. The loader validates
  // it (rule R2); a programmatic caller skips the loader, so check the closed set here.
  if (!(TIME_GRAINS as readonly string[]).includes(grain)) {
    throw new Error(`time-sql: "${String(grain)}" is not a time grain (${TIME_GRAINS.join(", ")}).`);
  }
  if (grain === GRAIN_HOUR && temporal === "date") {
    // Rule D4 forbids this at load; a programmatic caller skips the loader.
    throw new Error(`time-sql: the "hour" grain cannot truncate a date column (${ref}).`);
  }
  switch (dialect) {
    case "postgres":
      return truncatePostgres(ref, grain, temporal);
    case "sqlite":
      return truncateSqlite(ref, grain, temporal);
    case "mysql":
      return truncateMysql(ref, grain);
  }
}

function truncatePostgres(x: string, grain: TimeGrain, temporal: ReportTemporal): string {
  switch (temporal) {
    case "instant":
      return grain === GRAIN_HOUR
        ? `date_trunc('hour', ${x}, 'UTC')`
        : `CAST(date_trunc('${grain}', ${x} AT TIME ZONE 'UTC') AS DATE)`;
    case "naive":
      return grain === GRAIN_HOUR
        ? `date_trunc('hour', ${x})`
        : `CAST(date_trunc('${grain}', ${x}) AS DATE)`;
    case "date":
      // date_trunc(text, date) resolves to the timestamptz overload and truncates in
      // the session zone, so the date is cast to TIMESTAMP first.
      return grain === GRAIN_DAY
        ? x
        : `CAST(date_trunc('${grain}', CAST(${x} AS TIMESTAMP)) AS DATE)`;
  }
}

function truncateSqlite(x: string, grain: TimeGrain, temporal: ReportTemporal): string {
  switch (grain) {
    case GRAIN_HOUR:
      return temporal === "instant"
        ? `strftime('%Y-%m-%dT%H:00:00.000Z', ${x})`
        : `strftime('%Y-%m-%dT%H:00:00', ${x})`;
    case GRAIN_DAY:
      return `date(${x})`;
    case GRAIN_WEEK:
      return `date(${x}, 'weekday 0', '-6 days')`;
    case GRAIN_MONTH:
      return `date(${x}, 'start of month')`;
    case GRAIN_QUARTER:
      return `date(${x}, 'start of month', '-' || ((CAST(strftime('%m', ${x}) AS INTEGER) - 1) % 3) || ' months')`;
    case GRAIN_YEAR:
      return `date(${x}, 'start of year')`;
  }
}

function truncateMysql(x: string, grain: TimeGrain): string {
  switch (grain) {
    case GRAIN_HOUR:
      return `CAST(DATE_FORMAT(${x}, '%Y-%m-%d %H:00:00') AS DATETIME(3))`;
    case GRAIN_DAY:
      return `DATE(${x})`;
    case GRAIN_WEEK:
      return `DATE(DATE_SUB(${x}, INTERVAL WEEKDAY(${x}) DAY))`;
    case GRAIN_MONTH:
      return `DATE(DATE_FORMAT(${x}, '%Y-%m-01'))`;
    case GRAIN_QUARTER:
      return `MAKEDATE(YEAR(${x}), 1) + INTERVAL (QUARTER(${x}) - 1) QUARTER`;
    case GRAIN_YEAR:
      return `MAKEDATE(YEAR(${x}), 1)`;
  }
}

/** Table E. `{ now: "<duration>" }` as SQL, evaluated when the view is queried. */
export function relativeNowSql(
  duration: string,
  temporal: ReportTemporal,
  dialect: ReportDialect,
): string {
  const d = parseIsoDuration(duration);
  switch (dialect) {
    case "postgres": {
      // ISO-8601 interval input is accepted as written.
      const interval = `INTERVAL '${d.magnitude}'`;
      if (temporal === "instant") return `(now() ${d.sign} ${interval})`;
      const utcWall = `((now() AT TIME ZONE 'UTC') ${d.sign} ${interval})`;
      return temporal === "naive" ? utcWall : `CAST(${utcWall} AS DATE)`;
    }
    case "sqlite": {
      // One modifier per non-zero component, Y M W D H M S order; a week is 7 days.
      const mods = [
        [d.years, "years"], [d.months, "months"], [d.weeks * 7, "days"], [d.days, "days"],
        [d.hours, "hours"], [d.minutes, "minutes"], [d.seconds, "seconds"],
      ]
        .filter(([n]) => (n as number) !== 0)
        .map(([n, unit]) => `'${d.sign}${n} ${unit}'`);
      const args = ["'now'", ...mods].join(", ");
      if (temporal === "date") return `date(${args})`;
      const fmt = temporal === "instant" ? "%Y-%m-%dT%H:%M:%fZ" : "%Y-%m-%dT%H:%M:%f";
      return `strftime('${fmt}', ${args})`;
    }
    case "mysql": {
      const intervals = [
        [d.years, "YEAR"], [d.months, "MONTH"], [d.weeks, "WEEK"], [d.days, "DAY"],
        [d.hours, "HOUR"], [d.minutes, "MINUTE"], [d.seconds, "SECOND"],
      ]
        .filter(([n]) => (n as number) !== 0)
        .map(([n, unit]) => ` ${d.sign} INTERVAL ${n} ${unit}`)
        .join("");
      const now = `UTC_TIMESTAMP(3)${intervals}`;
      return temporal === "date" ? `DATE(${now})` : `(${now})`;
    }
  }
}
