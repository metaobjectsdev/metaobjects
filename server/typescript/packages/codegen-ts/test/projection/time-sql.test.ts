import { describe, expect, test } from "bun:test";
import { parseIsoDuration, relativeNowSql, truncateToGrain } from "../../src/projection/time-sql.js";

const X = `p."created_ts"`;

describe("truncateToGrain (Table D)", () => {
  test.each([
    ["hour", "instant", `date_trunc('hour', ${X}, 'UTC')`],
    ["day", "instant", `CAST(date_trunc('day', ${X} AT TIME ZONE 'UTC') AS DATE)`],
    ["week", "instant", `CAST(date_trunc('week', ${X} AT TIME ZONE 'UTC') AS DATE)`],
    ["month", "instant", `CAST(date_trunc('month', ${X} AT TIME ZONE 'UTC') AS DATE)`],
    ["quarter", "instant", `CAST(date_trunc('quarter', ${X} AT TIME ZONE 'UTC') AS DATE)`],
    ["year", "instant", `CAST(date_trunc('year', ${X} AT TIME ZONE 'UTC') AS DATE)`],
    ["hour", "naive", `date_trunc('hour', ${X})`],
    ["day", "naive", `CAST(date_trunc('day', ${X}) AS DATE)`],
    ["week", "naive", `CAST(date_trunc('week', ${X}) AS DATE)`],
    ["month", "naive", `CAST(date_trunc('month', ${X}) AS DATE)`],
    ["quarter", "naive", `CAST(date_trunc('quarter', ${X}) AS DATE)`],
    ["year", "naive", `CAST(date_trunc('year', ${X}) AS DATE)`],
    ["day", "date", X],
    ["week", "date", `CAST(date_trunc('week', CAST(${X} AS TIMESTAMP)) AS DATE)`],
    ["month", "date", `CAST(date_trunc('month', CAST(${X} AS TIMESTAMP)) AS DATE)`],
    ["quarter", "date", `CAST(date_trunc('quarter', CAST(${X} AS TIMESTAMP)) AS DATE)`],
    ["year", "date", `CAST(date_trunc('year', CAST(${X} AS TIMESTAMP)) AS DATE)`],
  ] as const)("postgres %s on %s", (grain, temporal, sql) => {
    expect(truncateToGrain(X, grain, temporal, "postgres")).toBe(sql);
  });

  const SQLITE_QUARTER = `date(${X}, 'start of month', '-' || ((CAST(strftime('%m', ${X}) AS INTEGER) - 1) % 3) || ' months')`;
  test.each([
    ["hour", "instant", `strftime('%Y-%m-%dT%H:00:00.000Z', ${X})`],
    ["hour", "naive", `strftime('%Y-%m-%dT%H:00:00', ${X})`],
    ...(["instant", "naive", "date"] as const).flatMap((t) => [
      ["day", t, `date(${X})`],
      ["week", t, `date(${X}, 'weekday 0', '-6 days')`],
      ["month", t, `date(${X}, 'start of month')`],
      ["quarter", t, SQLITE_QUARTER],
      ["year", t, `date(${X}, 'start of year')`],
    ] as const),
  ] as const)("sqlite %s on %s", (grain, temporal, sql) => {
    expect(truncateToGrain(X, grain, temporal, "sqlite")).toBe(sql);
  });

  const MYSQL = [
    ["hour", `CAST(DATE_FORMAT(${X}, '%Y-%m-%d %H:00:00') AS DATETIME(3))`],
    ["day", `DATE(${X})`],
    ["week", `DATE(DATE_SUB(${X}, INTERVAL WEEKDAY(${X}) DAY))`],
    ["month", `DATE(DATE_FORMAT(${X}, '%Y-%m-01'))`],
    ["quarter", `MAKEDATE(YEAR(${X}), 1) + INTERVAL (QUARTER(${X}) - 1) QUARTER`],
    ["year", `MAKEDATE(YEAR(${X}), 1)`],
  ] as const;
  test.each(MYSQL)("mysql %s", (grain, sql) => {
    expect(truncateToGrain(X, grain, "naive", "mysql")).toBe(sql);
  });
  test.each(MYSQL.filter(([g]) => g !== "hour"))("mysql %s is the same for every column kind", (grain, sql) => {
    for (const temporal of ["instant", "date"] as const) {
      expect(truncateToGrain(X, grain, temporal, "mysql")).toBe(sql);
    }
  });
  test("mysql hour is the same on an instant", () => {
    expect(truncateToGrain(X, "hour", "instant", "mysql")).toBe(MYSQL[0][1]);
  });

  test.each(["postgres", "sqlite", "mysql"] as const)("hour on a date column throws (%s)", (dialect) => {
    expect(() => truncateToGrain(X, "hour", "date", dialect)).toThrow(/hour/);
  });

  test.each(["postgres", "sqlite", "mysql"] as const)(
    "a grain outside the closed set is refused, never interpolated into SQL (%s)",
    (dialect) => {
      // A programmatic caller skips the loader; the Postgres arm writes the grain into
      // date_trunc('<grain>', ...), so an unchecked string would reach the DDL.
      const hostile = "day', now()); DROP TABLE t; --" as unknown as "day";
      expect(() => truncateToGrain(X, hostile, "instant", dialect)).toThrow(
        `time-sql: "day', now()); DROP TABLE t; --" is not a time grain (hour, day, week, month, quarter, year).`,
      );
    },
  );
});

describe("relativeNowSql (Table E)", () => {
  test.each([
    ["-P7D", "instant", `(now() - INTERVAL 'P7D')`],
    ["+P7D", "instant", `(now() + INTERVAL 'P7D')`],
    ["P7D", "instant", `(now() + INTERVAL 'P7D')`],
    ["-P1Y2M3WT4H5M6S", "instant", `(now() - INTERVAL 'P1Y2M3WT4H5M6S')`],
    ["PT12H", "naive", `((now() AT TIME ZONE 'UTC') + INTERVAL 'PT12H')`],
    ["-P2W", "naive", `((now() AT TIME ZONE 'UTC') - INTERVAL 'P2W')`],
    ["-P1Y", "date", `CAST(((now() AT TIME ZONE 'UTC') - INTERVAL 'P1Y') AS DATE)`],
    ["+P1D", "date", `CAST(((now() AT TIME ZONE 'UTC') + INTERVAL 'P1D') AS DATE)`],
  ] as const)("postgres %s on %s", (duration, temporal, sql) => {
    expect(relativeNowSql(duration, temporal, "postgres")).toBe(sql);
  });

  test.each([
    ["-P7D", "instant", `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')`],
    ["P1D", "instant", `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 days')`],
    ["-P1Y2M3WT4H", "naive", `strftime('%Y-%m-%dT%H:%M:%f', 'now', '-1 years', '-2 months', '-21 days', '-4 hours')`],
    ["PT5M6S", "naive", `strftime('%Y-%m-%dT%H:%M:%f', 'now', '+5 minutes', '+6 seconds')`],
    ["-P1W2D", "instant", `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days', '-2 days')`],
    ["+P1D", "date", `date('now', '+1 days')`],
    ["-P1Y2M3DT4H5M6S", "date", `date('now', '-1 years', '-2 months', '-3 days', '-4 hours', '-5 minutes', '-6 seconds')`],
    ["P0D", "date", `date('now')`],
  ] as const)("sqlite %s on %s", (duration, temporal, sql) => {
    expect(relativeNowSql(duration, temporal, "sqlite")).toBe(sql);
  });

  test.each([
    ["-P30D", "instant", `(UTC_TIMESTAMP(3) - INTERVAL 30 DAY)`],
    ["-P1Y2W", "naive", `(UTC_TIMESTAMP(3) - INTERVAL 1 YEAR - INTERVAL 2 WEEK)`],
    ["-P1Y2M3W4DT5H6M7S", "instant",
      `(UTC_TIMESTAMP(3) - INTERVAL 1 YEAR - INTERVAL 2 MONTH - INTERVAL 3 WEEK - INTERVAL 4 DAY - INTERVAL 5 HOUR - INTERVAL 6 MINUTE - INTERVAL 7 SECOND)`],
    ["PT12H", "naive", `(UTC_TIMESTAMP(3) + INTERVAL 12 HOUR)`],
    ["-P7D", "date", `DATE(UTC_TIMESTAMP(3) - INTERVAL 7 DAY)`],
    ["P0D", "instant", `(UTC_TIMESTAMP(3))`],
  ] as const)("mysql %s on %s", (duration, temporal, sql) => {
    expect(relativeNowSql(duration, temporal, "mysql")).toBe(sql);
  });

  test("a malformed duration throws, naming it", () => {
    expect(() => parseIsoDuration("P")).toThrow(/P/);
    expect(() => relativeNowSql("7 days", "instant", "postgres")).toThrow(/7 days/);
  });
});

describe("parseIsoDuration", () => {
  test("splits every component and the sign", () => {
    expect(parseIsoDuration("-P1Y2M3W4DT5H6M7S")).toEqual({
      sign: "-", years: 1, months: 2, weeks: 3, days: 4, hours: 5, minutes: 6, seconds: 7,
      magnitude: "P1Y2M3W4DT5H6M7S",
    });
  });
  test("an unsigned duration is positive and absent components are zero", () => {
    expect(parseIsoDuration("PT90M")).toEqual({
      sign: "+", years: 0, months: 0, weeks: 0, days: 0, hours: 0, minutes: 90, seconds: 0,
      magnitude: "PT90M",
    });
    expect(parseIsoDuration("+P7D").sign).toBe("+");
    expect(parseIsoDuration("+P7D").magnitude).toBe("P7D");
  });
  test("a month is not a minute", () => {
    const p = parseIsoDuration("P3MT4M");
    expect([p.months, p.minutes]).toEqual([3, 4]);
  });
});
