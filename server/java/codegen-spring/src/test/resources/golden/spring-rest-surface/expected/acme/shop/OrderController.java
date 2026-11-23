package acme.shop;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.generator.spring.runtime.ConstraintErrors;
import com.metaobjects.generator.spring.runtime.FilterParseResult;
import com.metaobjects.generator.spring.runtime.FilterParser;
import com.metaobjects.generator.spring.runtime.FilterPredicate;
import com.metaobjects.generator.spring.runtime.PatchValidationException;
import com.metaobjects.generator.spring.runtime.RecordComponentNames;
import com.metaobjects.generator.spring.runtime.UnknownBodyKeys;
import com.metaobjects.generator.spring.runtime.UnreadableBody;
import com.metaobjects.generator.spring.runtime.ValidationIssues;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Validator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * GENERATED — REST controller for Order entity. Implements the cross-port API contract.
 *
 * <p>Auth: these endpoints are unauthenticated. Require authentication for this path in
 * your Spring Security config, e.g. {@code http.authorizeHttpRequests(a ->
 * a.requestMatchers("/api/orders/**").authenticated())}.
 * A row-ownership rule ("only the owner may read this row") can't be expressed in path
 * config — eject this generator with {@code mvn metaobjects:eject} and hand-write those
 * endpoints.
 */
@RestController
@RequestMapping("/api/orders")
public class OrderController {
    private static final Set<String> SORT_ALLOWLIST = Set.of("id", "customerId", "total", "placedOn", "rush");

    private static final Map<String, String> SORT_DEFAULT_ORDER = Map.ofEntries();

    /** Components the server owns on create (primary key, @autoSet): a
     *  @NotNull on one of these describes the RESPONSE shape and must not
     *  reject a create body that legitimately omits it. */
    private static final Set<String> SERVER_OWNED_ON_CREATE = Set.of("id");

    /** Every field the entity declares, as named on the wire: a body key outside it is refused. */
    private static final Set<String> KNOWN_FIELDS = Set.of("id", "customerId", "total", "placedOn", "rush");

    private final OrderRepository repository;
    private final ObjectMapper objectMapper;
    private final Validator validator;

    public OrderController(OrderRepository repository, ObjectMapper objectMapper, Validator validator) {
        this.repository = repository;
        this.objectMapper = objectMapper;
        this.validator = validator;
    }

    @org.springframework.web.bind.annotation.ExceptionHandler(org.springframework.http.converter.HttpMessageNotReadableException.class)
    public ResponseEntity<?> onUnreadableBody(org.springframework.http.converter.HttpMessageNotReadableException e) {
        return ResponseEntity.badRequest().body(UnreadableBody.envelope(e));
    }

    @GetMapping
    public ResponseEntity<?> list(
            @RequestParam(required = false) Integer limit,
            @RequestParam(required = false) Integer offset,
            @RequestParam(required = false) String sort,
            @RequestParam(required = false, name = "withCount") Integer withCount,
            HttpServletRequest request) {
        int actualLimit = limit != null ? limit : 50;
        int actualOffset = offset != null ? offset : 0;
        OrderRepository.SortClause sortClause = null;
        if (sort != null) {
            sortClause = parseSort(sort);
            if (sortClause == null) {
                return ResponseEntity.badRequest().body(Map.of("error", "invalid_sort", "field", sort.split(":", 2)[0]));
            }
        }
        FilterParseResult filter = FilterParser.parse(
                request.getQueryString(), OrderFilterAllowlist.FIELDS, OrderFilterAllowlist.OPS_BY_FIELD, OrderFilterAllowlist.DECIMAL_FIELDS, OrderFilterAllowlist.DURATION_FIELDS);
        if (filter.error() != null) {
            return ResponseEntity.badRequest().body(Map.of("error", filter.error(), "field", filter.field()));
        }
        List<FilterPredicate> filters = filter.predicates();
        List<OrderDto> rows = repository.list(actualLimit, actualOffset, sortClause, filters);
        if (withCount != null && withCount == 1) {
            long total = repository.count(filters);
            return ResponseEntity.ok(Map.of("rows", rows, "total", total));
        }
        return ResponseEntity.ok(rows);
    }

    @GetMapping("/{id}")
    public ResponseEntity<?> get(@PathVariable Long id) {
        return repository.findById(id)
                .<ResponseEntity<?>>map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "not_found")));
    }

    @PostMapping
    public ResponseEntity<?> create(@RequestBody JsonNode body) {
        if (!(body instanceof com.fasterxml.jackson.databind.node.ObjectNode given)) {
            return ResponseEntity.badRequest().body(new ValidationIssues()
                    .add(ValidationIssues.INVALID_TYPE, java.util.List.of(), "request body must be a JSON object").body());
        }
        Map<String, Object> __unknown = UnknownBodyKeys.refusal(body, KNOWN_FIELDS);
        if (__unknown != null) {
            return ResponseEntity.badRequest().body(__unknown);
        }
        com.fasterxml.jackson.databind.node.ObjectNode filled = given.deepCopy();
        OrderDto dto;
        try {
            dto = objectMapper.treeToValue(filled, OrderDto.class);
        } catch (com.fasterxml.jackson.core.JsonProcessingException | IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(UnreadableBody.envelope(e));
        }
        dto = new OrderDto(null, dto.customerId(), dto.total(), dto.placedOn(), dto.rush());
        ValidationIssues __issues = new ValidationIssues()
                .addViolationsExcept(validator.validate(dto), SERVER_OWNED_ON_CREATE);
        if (!__issues.isEmpty()) {
            return ResponseEntity.badRequest().body(__issues.body());
        }
        try {
            OrderDto saved = repository.create(dto);
            return ResponseEntity.status(HttpStatus.CREATED).body(saved);
        } catch (RuntimeException e) {
            ConstraintErrors.Failure failure = ConstraintErrors.classify(e);
            if (failure == null) throw e;
            return ResponseEntity.status(failure.status())
                    .body(Map.of("error", failure.error(), "constraint", failure.constraint()));
        }
    }

    @RequestMapping(value = "/{id}", method = { RequestMethod.PATCH, RequestMethod.PUT })
    public ResponseEntity<?> update(@PathVariable Long id, @RequestBody JsonNode body) {
        Map<String, Object> __unknown = UnknownBodyKeys.refusal(body, KNOWN_FIELDS);
        if (__unknown != null) {
            return ResponseEntity.badRequest().body(__unknown);
        }
        ValidationIssues __issues = new ValidationIssues();
        OrderPatch __patch = null;
        Map<String, Object> __assigned;
        try {
            __patch = OrderPatch.fromJson(body, objectMapper);
            __assigned = __patch.assignedValues();
        } catch (PatchValidationException e) {
            __issues.addPatchFailure(e);
            __assigned = e.assignedValues();
        }
        for (Map.Entry<String, Object> __e : __assigned.entrySet()) {
            __issues.addAt(validator.validateValue(OrderDto.class, RecordComponentNames.escape(__e.getKey()), __e.getValue()), __e.getKey());
        }
        if (!__issues.isEmpty()) {
            return ResponseEntity.badRequest().body(__issues.body());
        }
        final var patch = __patch;
        try {
            return repository.patch(id, patch)
                    .<ResponseEntity<?>>map(ResponseEntity::ok)
                    .orElseGet(() -> ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "not_found")));
        } catch (RuntimeException e) {
            ConstraintErrors.Failure failure = ConstraintErrors.classify(e);
            if (failure == null) throw e;
            return ResponseEntity.status(failure.status())
                    .body(Map.of("error", failure.error(), "constraint", failure.constraint()));
        }
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<?> delete(@PathVariable Long id) {
        try {
            if (repository.delete(id)) {
                return ResponseEntity.noContent().build();
            }
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "not_found"));
        } catch (RuntimeException e) {
            ConstraintErrors.Failure failure = ConstraintErrors.classify(e);
            if (failure == null) throw e;
            return ResponseEntity.status(failure.status())
                    .body(Map.of("error", failure.error(), "constraint", failure.constraint()));
        }
    }

    @GetMapping("/{id}/tags")
    public ResponseEntity<List<TagDto>> findTags(@PathVariable Long id) {
        return ResponseEntity.ok(repository.findTags(id));
    }

    private static OrderRepository.SortClause parseSort(String raw) {
        String[] parts = raw.split(":", 2);
        if (parts.length == 0 || parts[0].isEmpty() || !SORT_ALLOWLIST.contains(parts[0])) return null;
        String dir = parts.length == 2 ? parts[1].toLowerCase()
            : SORT_DEFAULT_ORDER.getOrDefault(parts[0], "asc");
        if (!dir.equals("asc") && !dir.equals("desc")) return null;
        return new OrderRepository.SortClause(parts[0], dir);
    }
}
