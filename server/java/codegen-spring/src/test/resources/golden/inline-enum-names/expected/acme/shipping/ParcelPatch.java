package acme.shipping;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.generator.spring.runtime.PatchValidationException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/** GENERATED — presence-tracked partial-update (PATCH) shape for Parcel. Do not hand-edit; regenerated from metadata. */
public final class ParcelPatch {

    private final Map<String, Object> assigned;

    private ParcelPatch(Map<String, Object> assigned) { this.assigned = assigned; }

    public boolean hasPhase() { return assigned.containsKey("phase"); }
    public ParcelDto.Status phase() { return (ParcelDto.Status) assigned.get("phase"); }

    /** The field names ASSIGNED by this patch (present in the body), in order. */
    public Set<String> assignedFields() { return assigned.keySet(); }

    /** The name&rarr;value map of fields ASSIGNED by this patch (present values, incl. explicit null). */
    public java.util.Map<String, Object> assignedValues() { return java.util.Collections.unmodifiableMap(assigned); }

    /**
     * Build from a JSON body. A non-object body is rejected; an ABSENT key is
     * untouched; a present null CLEARS a non-@required field and is a validation
     * error on a @required one; a present value binds via Jackson exactly as
     * create does. Unknown keys are ignored (FR-035 PATCH-3 deferred).
     */
    public static ParcelPatch fromJson(JsonNode body, ObjectMapper mapper) {
        if (!body.isObject()) throw new PatchValidationException("(request body)");
        Map<String, Object> assigned = new LinkedHashMap<>();
        bind(body, mapper, assigned, "phase", new TypeReference<ParcelDto.Status>() {}, true);
        return new ParcelPatch(assigned);
    }

    private static void bind(JsonNode body, ObjectMapper mapper, Map<String, Object> assigned,
            String field, TypeReference<?> type, boolean required) {
        if (!body.has(field)) return;                         // absent → untouched
        JsonNode node = body.get(field);
        if (node.isNull()) {
            if (required) throw new PatchValidationException(field);
            assigned.put(field, null);                         // explicit null → clear
            return;
        }
        try {
            assigned.put(field, mapper.treeToValue(node, type));
        } catch (JsonProcessingException e) {
            throw new PatchValidationException(field);
        }
    }
}
