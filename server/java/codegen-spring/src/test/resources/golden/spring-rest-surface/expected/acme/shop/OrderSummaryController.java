package acme.shop;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import com.metaobjects.generator.spring.runtime.FilterParseResult;
import com.metaobjects.generator.spring.runtime.FilterParser;
import com.metaobjects.generator.spring.runtime.FilterPredicate;
import jakarta.servlet.http.HttpServletRequest;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * GENERATED — READ-ONLY REST controller for the OrderSummary projection.
 * Implements the cross-port API contract: GET list + GET by id; every write
 * verb answers 405 {"error": "method_not_allowed"}.
 *
 * <p>Auth: these read endpoints are unauthenticated. Require authentication for this path
 * in your Spring Security config, e.g. {@code http.authorizeHttpRequests(a ->
 * a.requestMatchers("/api/order_summaries/**").authenticated())}.
 * A row-ownership rule ("only the owner may read this row") can't be expressed in path
 * config — eject this generator with {@code mvn metaobjects:eject} and hand-write those
 * endpoints.
 */
@RestController
@RequestMapping("/api/order_summaries")
public class OrderSummaryController {

    private static final Set<String> SORT_ALLOWLIST = Set.of("id", "total", "placedOn");

    private static final Map<String, String> SORT_DEFAULT_ORDER = Map.ofEntries();

    private final OrderSummaryRepository repository;

    public OrderSummaryController(OrderSummaryRepository repository) {
        this.repository = repository;
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
        OrderSummaryRepository.SortClause sortClause = null;
        if (sort != null) {
            sortClause = parseSort(sort);
            if (sortClause == null) {
                return ResponseEntity.badRequest().body(Map.of("error", "invalid_sort", "field", sort.split(":", 2)[0]));
            }
        }
        FilterParseResult filter = FilterParser.parse(
                request.getQueryString(), OrderSummaryFilterAllowlist.FIELDS, OrderSummaryFilterAllowlist.OPS_BY_FIELD, OrderSummaryFilterAllowlist.DECIMAL_FIELDS, OrderSummaryFilterAllowlist.DURATION_FIELDS);
        if (filter.error() != null) {
            return ResponseEntity.badRequest().body(Map.of("error", filter.error(), "field", filter.field()));
        }
        List<FilterPredicate> filters = filter.predicates();
        List<OrderSummaryDto> rows = repository.list(actualLimit, actualOffset, sortClause, filters);
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
    public ResponseEntity<?> create() {
        return methodNotAllowed("POST");
    }

    @RequestMapping(value = "/{id}", method = { RequestMethod.PATCH, RequestMethod.PUT, RequestMethod.DELETE })
    public ResponseEntity<?> rejectItemWrite(@PathVariable Long id, HttpServletRequest request) {
        return methodNotAllowed(request.getMethod());
    }

    private static ResponseEntity<?> methodNotAllowed(String verb) {
        return ResponseEntity.status(HttpStatus.METHOD_NOT_ALLOWED)
                .body(Map.of("error", "method_not_allowed",
                        "message", verb + " is not supported on a projection (read-only)."));
    }

    private static OrderSummaryRepository.SortClause parseSort(String raw) {
        String[] parts = raw.split(":", 2);
        if (parts.length == 0 || parts[0].isEmpty() || !SORT_ALLOWLIST.contains(parts[0])) return null;
        String dir = parts.length == 2 ? parts[1].toLowerCase()
            : SORT_DEFAULT_ORDER.getOrDefault(parts[0], "asc");
        if (!dir.equals("asc") && !dir.equals("desc")) return null;
        return new OrderSummaryRepository.SortClause(parts[0], dir);
    }
}
