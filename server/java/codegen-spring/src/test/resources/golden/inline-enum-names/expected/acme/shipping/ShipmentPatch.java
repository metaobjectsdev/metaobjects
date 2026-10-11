package acme.shipping;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.generator.spring.runtime.PatchValidationException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/** GENERATED — presence-tracked partial-update (PATCH) shape for Shipment. Do not hand-edit; regenerated from metadata. */
public final class ShipmentPatch {

    private final Map<String, Object> assigned;

    private ShipmentPatch(Map<String, Object> assigned) { this.assigned = assigned; }

    public boolean hasStatus() { return assigned.containsKey("status"); }
    public ShipmentDto.ShipmentStatus status() { return (ShipmentDto.ShipmentStatus) assigned.get("status"); }
    public boolean hasMode() { return assigned.containsKey("mode"); }
    public ShipmentDto.ShipmentMode mode() { return (ShipmentDto.ShipmentMode) assigned.get("mode"); }

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
    public static ShipmentPatch fromJson(JsonNode body, ObjectMapper mapper) {
        if (!body.isObject()) throw new PatchValidationException("(request body)");
        Map<String, Object> assigned = new LinkedHashMap<>();
        bind(body, mapper, assigned, "status", new TypeReference<ShipmentDto.ShipmentStatus>() {}, true);
        bind(body, mapper, assigned, "mode", new TypeReference<ShipmentDto.ShipmentMode>() {}, false);
        return new ShipmentPatch(assigned);
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
