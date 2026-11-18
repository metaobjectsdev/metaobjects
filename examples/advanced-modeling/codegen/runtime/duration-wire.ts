// The field.duration wire rule lives in @metaobjectsdev/metadata (shared with migrate-ts);
// re-exported here so the runtime's callers import it beside the decimal wire helpers.
export {
  DURATION_PATTERN, DURATION_RE, parseDurationLiteral, formatDuration, formatPostgresInterval,
  canonicalDuration, parseDurationInput, parsePostgresInterval, durationToWire, durationToStoredMicros,
  DURATION_MICROS_MIN, DURATION_MICROS_MAX,
} from "@metaobjectsdev/metadata";
