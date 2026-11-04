package com.metaobjects.integration.api.generated;

/**
 * The Java SOURCE for an OMDB-backed {@code acme.ops.TimerRepository}: the adopter-owned seam of the
 * duration api-contract sub-corpus' writable entity. It is {@link OmdbEntryRepositorySource}'s seam
 * re-aimed at {@code Timer} (a {@code label} and a {@code java.time.Duration timeout}); a duration is
 * a {@link java.time.Duration} on the DTO, written to the model as its canonical text; a filter operand arrives already parsed to one.
 */
final class OmdbTimerRepositorySource {

    private OmdbTimerRepositorySource() {}

    static final String PKG = "acme.ops";
    static final String FQCN = PKG + ".OmdbTimerRepository";

    static final String SOURCE = OmdbEntryRepositorySource.SOURCE
        .replace("package acme.ledger;", "package " + PKG + ";")
        .replace("if (dto.bucket() != null) vo.setString(\"bucket\", dto.bucket());",
                 "if (dto.label() != null) vo.setString(\"label\", dto.label());")
        .replace("vo.setString(\"bucket\", dto.bucket());", "vo.setString(\"label\", dto.label());")
        .replace("vo.setObject(\"amount\", dto.amount());", "vo.setObject(\"timeout\", span(dto.timeout()));")
        .replace("if (dto.flagged() != null) vo.setBoolean(\"flagged\", dto.flagged());", "")
        .replace("vo.setBoolean(\"flagged\", Boolean.TRUE.equals(dto.flagged()));", "")
        .replace("if (patch.hasBucket()) vo.setString(\"bucket\", patch.bucket());",
                 "if (patch.hasLabel()) vo.setString(\"label\", patch.label());")
        .replace("if (patch.hasAmount()) vo.setObject(\"amount\", patch.amount());",
                 "if (patch.hasTimeout()) vo.setObject(\"timeout\", span(patch.timeout()));")
        .replace("if (patch.hasFlagged()) vo.setBoolean(\"flagged\", Boolean.TRUE.equals(patch.flagged()));", "")
        .replace("if (value instanceof BigDecimal exact) return exact;",
                 "if (value instanceof java.time.Duration span) return span(span);")
        .replace("    private Optional<ValueObject> load(",
                 "    /** A duration is stored from its canonical text, never Duration.toString (PT-1M-30S is not the accepted form). */\n"
                 + "    private static String span(java.time.Duration d) {\n"
                 + "        return d == null ? null : com.metaobjects.field.DurationWire.format(d);\n"
                 + "    }\n\n"
                 + "    private Optional<ValueObject> load(")
        .replace("OmdbEntryRepository", "OmdbTimerRepository")
        .replace("EntryRepository", "TimerRepository")
        .replace("EntryDto", "TimerDto")
        .replace("EntryPatch", "TimerPatch");
}
