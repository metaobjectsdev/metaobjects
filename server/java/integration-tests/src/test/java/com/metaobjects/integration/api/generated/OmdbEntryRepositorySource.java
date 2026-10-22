package com.metaobjects.integration.api.generated;

/**
 * The Java SOURCE for an OMDB-backed {@code acme.ledger.EntryRepository}: the adopter-owned seam of
 * the decimal api-contract sub-corpus' writable entity, emitted beside the GENERATED controller, DTO
 * and interface so it compiles against them (see {@link GeneratedDecimalControllerHarness}).
 *
 * <p>It is written the way an adopter writes it: the controller's {@code FilterPredicate} list,
 * {@code SortClause} and paging become an OMDB {@code Expression}, {@code SortOrder} and
 * {@code Range}; a write authors a {@code ValueObject} and goes through {@code createObject} /
 * {@code updateObject} / {@code deleteObject}; a decimal is a {@link java.math.BigDecimal} in both
 * directions, so nothing here converts through a double. No SQL is written here.</p>
 */
final class OmdbEntryRepositorySource {

    private OmdbEntryRepositorySource() {}

    static final String PKG = "acme.ledger";
    static final String FQCN = PKG + ".OmdbEntryRepository";

    static final String SOURCE = """
        package acme.ledger;

        import com.fasterxml.jackson.databind.ObjectMapper;
        import com.fasterxml.jackson.databind.SerializationFeature;
        import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
        import com.metaobjects.field.MetaField;
        import com.metaobjects.generator.spring.runtime.FilterPredicate;
        import com.metaobjects.manager.ObjectConnection;
        import com.metaobjects.manager.QueryOptions;
        import com.metaobjects.manager.db.ObjectManagerDB;
        import com.metaobjects.manager.exp.Expression;
        import com.metaobjects.manager.exp.Range;
        import com.metaobjects.manager.exp.SortOrder;
        import com.metaobjects.object.MetaObject;
        import com.metaobjects.object.value.ValueObject;

        import java.math.BigDecimal;
        import java.util.ArrayList;
        import java.util.LinkedHashMap;
        import java.util.List;
        import java.util.Map;
        import java.util.Optional;

        /** Hand-written OMDB-backed {@link EntryRepository}. NOT a conformance subject. */
        public final class OmdbEntryRepository implements EntryRepository {

            private static final ObjectMapper MAPPER = new ObjectMapper()
                .registerModule(new JavaTimeModule())
                .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);

            private final ObjectManagerDB omdb;
            private final MetaObject entry;

            public OmdbEntryRepository(ObjectManagerDB omdb, MetaObject entry) {
                this.omdb = omdb;
                this.entry = entry;
            }

            @Override
            public List<EntryDto> list(int limit, int offset, SortClause sort, List<FilterPredicate> filters) {
                ObjectConnection c = omdb.getConnection();
                try {
                    QueryOptions options = new QueryOptions();
                    Expression where = where(filters);
                    if (where != null) options.setExpression(where);
                    String field = sort != null ? sort.field() : "id";
                    boolean desc = sort != null && "desc".equalsIgnoreCase(sort.direction());
                    options.setSortOrder(new SortOrder(field, desc ? SortOrder.DESC : SortOrder.ASC));
                    options.setRange(new Range(offset + 1, offset + limit));   // 1-based, inclusive
                    List<EntryDto> out = new ArrayList<>();
                    for (Object o : omdb.getObjects(c, entry, options)) out.add(toDto((ValueObject) o));
                    return out;
                } finally {
                    omdb.releaseConnection(c);
                }
            }

            @Override
            public long count(List<FilterPredicate> filters) {
                ObjectConnection c = omdb.getConnection();
                try {
                    return omdb.getObjectsCount(c, entry, where(filters));
                } finally {
                    omdb.releaseConnection(c);
                }
            }

            @Override
            public Optional<EntryDto> findById(Long id) {
                ObjectConnection c = omdb.getConnection();
                try {
                    return load(c, id).map(this::toDto);
                } finally {
                    omdb.releaseConnection(c);
                }
            }

            @Override
            public EntryDto create(EntryDto dto) {
                ObjectConnection c = omdb.getConnection();
                try {
                    ValueObject vo = (ValueObject) entry.newInstance();
                    vo.setString("bucket", dto.bucket());
                    vo.setObject("amount", dto.amount());
                    vo.setBoolean("flagged", Boolean.TRUE.equals(dto.flagged()));
                    omdb.createObject(c, vo);
                    return load(c, (Long) vo.get("id")).map(this::toDto).orElseThrow();
                } finally {
                    omdb.releaseConnection(c);
                }
            }

            @Override
            public Optional<EntryDto> update(Long id, EntryDto dto) {
                ObjectConnection c = omdb.getConnection();
                try {
                    Optional<ValueObject> cur = load(c, id);
                    if (cur.isEmpty()) return Optional.empty();
                    ValueObject vo = cur.get();
                    if (dto.bucket() != null) vo.setString("bucket", dto.bucket());
                    vo.setObject("amount", dto.amount());
                    if (dto.flagged() != null) vo.setBoolean("flagged", dto.flagged());
                    omdb.updateObject(c, vo);
                    return load(c, id).map(this::toDto);
                } finally {
                    omdb.releaseConnection(c);
                }
            }

            @Override
            public Optional<EntryDto> patch(Long id, EntryPatch patch) {
                ObjectConnection c = omdb.getConnection();
                try {
                    Optional<ValueObject> cur = load(c, id);
                    if (cur.isEmpty()) return Optional.empty();
                    ValueObject vo = cur.get();
                    if (patch.hasBucket()) vo.setString("bucket", patch.bucket());
                    if (patch.hasAmount()) vo.setObject("amount", patch.amount());
                    if (patch.hasFlagged()) vo.setBoolean("flagged", Boolean.TRUE.equals(patch.flagged()));
                    omdb.updateObject(c, vo);
                    return load(c, id).map(this::toDto);
                } finally {
                    omdb.releaseConnection(c);
                }
            }

            @Override
            public boolean delete(Long id) {
                ObjectConnection c = omdb.getConnection();
                try {
                    return omdb.deleteObjects(c, entry, new Expression("id", id, Expression.EQUAL)) > 0;
                } finally {
                    omdb.releaseConnection(c);
                }
            }

            private Optional<ValueObject> load(ObjectConnection c, Long id) {
                for (Object o : omdb.getObjects(c, entry,
                        new QueryOptions(new Expression("id", id, Expression.EQUAL)))) {
                    return Optional.of((ValueObject) o);
                }
                return Optional.empty();
            }

            // --- predicates -> Expression ------------------------------------------------

            @SuppressWarnings("unchecked")
            private Expression where(List<FilterPredicate> filters) {
                if (filters == null) return null;
                Expression acc = null;
                for (FilterPredicate p : filters) {   // implicit AND
                    Expression e = switch (p.op()) {
                        case "isNull" -> new Expression(p.field(), null,
                            Boolean.TRUE.equals(p.value()) ? Expression.EQUAL : Expression.NOT_EQUAL);
                        case "in" -> {
                            List<Object> items = new ArrayList<>();
                            for (Object item : (List<Object>) p.value()) items.add(operand(p.field(), item));
                            yield new Expression(p.field(), items, Expression.EQUAL);
                        }
                        case "like" -> new Expression(p.field(), p.value(), Expression.LIKE);
                        case "eq"  -> new Expression(p.field(), operand(p.field(), p.value()), Expression.EQUAL);
                        case "ne"  -> new Expression(p.field(), operand(p.field(), p.value()), Expression.NOT_EQUAL);
                        case "gt"  -> new Expression(p.field(), operand(p.field(), p.value()), Expression.GREATER);
                        case "gte" -> new Expression(p.field(), operand(p.field(), p.value()), Expression.EQUAL_GREATER);
                        case "lt"  -> new Expression(p.field(), operand(p.field(), p.value()), Expression.LESSER);
                        case "lte" -> new Expression(p.field(), operand(p.field(), p.value()), Expression.EQUAL_LESSER);
                        default -> throw new IllegalStateException("unknown op: " + p.op());
                    };
                    acc = acc == null ? e : acc.and(e);
                }
                return acc;
            }

            /** A raw query operand as the field's own type, so the bind is typed. */
            private Object operand(String field, Object value) {
                // ADR-0019 Amendment 1: a decimal field's operand arrives parsed, as a BigDecimal.
                if (value instanceof BigDecimal exact) return exact;
                String raw = (String) value;
                MetaField<?> f = entry.getMetaField(field);
                return switch (f.getSubType()) {
                    case "long" -> Long.valueOf(raw);
                    case "boolean" -> Boolean.valueOf(raw);
                    default -> raw;
                };
            }

            private EntryDto toDto(ValueObject vo) {
                Map<String, Object> values = new LinkedHashMap<>();
                for (MetaField<?> f : entry.getMetaFields()) values.put(f.getName(), vo.get(f.getName()));
                return MAPPER.convertValue(values, EntryDto.class);
            }
        }
        """;

    /** The same seam for another entity of the corpus (same shape; only the names differ). */
    static String sourceFor(String entity) {
        String source = SOURCE;
        if (entity.equals("Sample")) {
            // Sample carries `readings` (a decimal array) and `free` (a decimal with no @precision).
            source = source
                .replace("if (dto.bucket() != null) vo.setString(\"bucket\", dto.bucket());", "vo.setObject(\"readings\", dto.readings());")
                .replace("if (dto.flagged() != null) vo.setBoolean(\"flagged\", dto.flagged());", "")
                .replace("vo.setString(\"bucket\", dto.bucket());", "vo.setObject(\"readings\", dto.readings());")
                .replace("vo.setObject(\"amount\", dto.amount());", "vo.setObject(\"free\", dto.free());")
                .replace("vo.setBoolean(\"flagged\", Boolean.TRUE.equals(dto.flagged()));", "")
                .replace("if (patch.hasBucket()) vo.setString(\"bucket\", patch.bucket());", "if (patch.hasReadings()) vo.setObject(\"readings\", patch.readings());")
                .replace("if (patch.hasAmount()) vo.setObject(\"amount\", patch.amount());", "if (patch.hasFree()) vo.setObject(\"free\", patch.free());")
                .replace("if (patch.hasFlagged()) vo.setBoolean(\"flagged\", Boolean.TRUE.equals(patch.flagged()));", "");
        }
        return source
            .replace("OmdbEntryRepository", "Omdb" + entity + "Repository")
            .replace("EntryRepository", entity + "Repository")
            .replace("EntryDto", entity + "Dto")
            .replace("EntryPatch", entity + "Patch");
    }

    static String fqcnFor(String entity) {
        return PKG + ".Omdb" + entity + "Repository";
    }
}
