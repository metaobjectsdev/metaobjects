// GENERATED — DO NOT EDIT — response parser for template.prompt `acme::shipping::Note`
package acme.shipping.prompts;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.render.extract.Format;
import com.metaobjects.render.extract.ExtractMap;

/** Parser for LLM responses matching the `Note` template.prompt. */
public final class NoteParser {

    private static final ObjectMapper MAPPER = new ObjectMapper().findAndRegisterModules();

    private NoteParser() { /* no instances */ }

    /**
     * Parse an LLM response into a typed {@link acme.shipping.ShipmentNote}.
     *
     * @throws JsonProcessingException when the input is not valid JSON for the response schema.
     */
    public static acme.shipping.ShipmentNote parse(String text) throws JsonProcessingException {
        return MAPPER.readValue(text, acme.shipping.ShipmentNote.class);
    }

    /** Payload FQN this parser extracts — resolved against the supplied loader at runtime. */
    public static final String PAYLOAD_FQN = "acme::shipping::ShipmentNote";

    /**
     * Tolerant best-effort extraction delegating to the runtime
     * {@link com.metaobjects.object.extract.MetaObjectExtractor}; never throws.
     * Fully populates nested-object and array-of-object components (unlike the
     * self-contained {@code extractLenient(String)} overload). Resolves this payload's
     * {@code MetaObject} by {@link #PAYLOAD_FQN} from {@code loader}.
     */
    public static com.metaobjects.render.extract.ExtractionResult<acme.shipping.ShipmentNote> extractLenient(com.metaobjects.loader.MetaDataLoader loader, String text) {
        return extractLenient(loader, text, com.metaobjects.render.extract.ExtractOptions.defaults());
    }

    public static com.metaobjects.render.extract.ExtractionResult<acme.shipping.ShipmentNote> extractLenient(com.metaobjects.loader.MetaDataLoader loader, String text, com.metaobjects.render.extract.ExtractOptions opts) {
        com.metaobjects.object.MetaObject mo = loader.getMetaObjectByName(PAYLOAD_FQN);
        com.metaobjects.render.extract.ExtractionResult<Object> raw =
            com.metaobjects.object.extract.MetaObjectExtractor.extract(mo, text, Format.JSON, opts);
        // The assembled graph is a ValueObject (a Map<String,Object>) with nested
        // ValueObjects / List<ValueObject> — map it into the value objects' records.
        @SuppressWarnings("unchecked")
        java.util.Map<String, Object> d = (java.util.Map<String, Object>) raw.data();
        return new com.metaobjects.render.extract.ExtractionResult<>(fromShipmentNote(d), raw.report());
    }

    /** Map an assembled ValueObject (Map) into a typed {@link acme.shipping.ShipmentNote}. Generated; null-tolerant. */
    private static acme.shipping.ShipmentNote fromShipmentNote(java.util.Map<String, Object> d) {
        if (d == null) return null;
        return new acme.shipping.ShipmentNote(
                ExtractMap.asString(d, "text"),
                java.util.Optional.ofNullable(ExtractMap.asString(d, "kind")).map(acme.shipping.ShipmentNote.ShipmentNoteKind::valueOf).orElse(null),
                java.util.Optional.ofNullable(ExtractMap.asString(d, "status")).map(acme.shipping.ShipmentNote.Status::valueOf).orElse(null),
                java.util.Optional.ofNullable(ExtractMap.asString(d, "stage")).map(acme.shipping.ShipmentNote.Status::valueOf).orElse(null)
        );
    }

    /** Null-tolerant cast of an assembled value to a Map (a ValueObject IS a Map). */
    @SuppressWarnings("unchecked")
    private static java.util.Map<String, Object> asMap(Object v) {
        return (v instanceof java.util.Map) ? (java.util.Map<String, Object>) v : null;
    }

    /** Map each element of an assembled List<Map> via {@code fn}; null/absent -> null; non-Map elements skipped. */
    private static <T> java.util.List<T> mapObjectList(
            java.util.Map<String, Object> d, String key,
            java.util.function.Function<java.util.Map<String, Object>, T> fn) {
        Object v = d == null ? null : d.get(key);
        if (!(v instanceof java.util.List<?> list)) return null;
        java.util.List<T> out = new java.util.ArrayList<>(list.size());
        for (Object elem : list) {
            java.util.Map<String, Object> m = asMap(elem);
            if (m != null) out.add(fn.apply(m));
        }
        return out;
    }
}
