package acme.shop;

import com.metaobjects.generator.spring.runtime.FilterParseResult;
import com.metaobjects.generator.spring.runtime.FilterParser;
import com.metaobjects.generator.spring.runtime.FilterPredicate;
import jakarta.servlet.http.HttpServletRequest;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * GENERATED — READ-ONLY REST controller for the CustomerStatusTotals report.
 * Implements the cross-port API contract: GET list; POST answers
 * 405 {"error": "method_not_allowed"}. A report has no identity, so no item
 * route is mounted.
 *
 * <p>Auth: these read endpoints are unauthenticated. Require authentication for this path
 * in your Spring Security config, e.g. {@code http.authorizeHttpRequests(a ->
 * a.requestMatchers("/api/customer_status_totals/**").authenticated())}.
 * A row-ownership rule ("only the owner may read this row") can't be expressed in path
 * config — eject this generator with {@code mvn metaobjects:eject} and hand-write those
 * endpoints.
 */
@RestController
@RequestMapping("/api/customer_status_totals")
public class CustomerStatusTotalsController {
    private static final Set<String> SORT_ALLOWLIST = Set.of("status", "customers", "activeCustomers");

    private static final Map<String, String> SORT_DEFAULT_ORDER = Map.ofEntries();

    private final CustomerStatusTotalsRepository repository;

    public CustomerStatusTotalsController(CustomerStatusTotalsRepository repository) {
        this.repository = repository;
    }

    @GetMapping
    public ResponseEntity<?> list(
            @RequestParam(required = false) String limit,
            @RequestParam(required = false) String offset,
            @RequestParam(required = false) String sort,
            @RequestParam(required = false, name = "withCount") Integer withCount,
            HttpServletRequest request) {
        final int maxRows = 10000;
        Integer requestedLimit = null;
        if (limit != null) {
            Long parsed = parseBound(limit, 1);
            if (parsed == null) {
                return ResponseEntity.badRequest().body(Map.of("error", "pagination.invalid_value", "param", "limit", "value", limit, "expected", "an integer from 1 to " + maxRows));
            }
            if (parsed > maxRows) {
                return ResponseEntity.badRequest().body(Map.of("error", "report_too_large", "maxRows", maxRows));
            }
            requestedLimit = parsed.intValue();
        }
        int actualOffset = 0;
        if (offset != null) {
            Long parsed = parseBound(offset, 0);
            if (parsed == null) {
                return ResponseEntity.badRequest().body(Map.of("error", "pagination.invalid_value", "param", "offset", "value", offset, "expected", "a non-negative integer (0 or more)"));
            }
            actualOffset = (int) Math.min(parsed, Integer.MAX_VALUE);
        }
        CustomerStatusTotalsRepository.SortClause sortClause = null;
        if (sort != null) {
            sortClause = parseSort(sort);
            if (sortClause == null) {
                return ResponseEntity.badRequest().body(Map.of("error", "invalid_sort", "field", sort.split(":", 2)[0]));
            }
        }
        FilterParseResult filter = FilterParser.parse(
                request.getQueryString(), CustomerStatusTotalsFilterAllowlist.FIELDS, CustomerStatusTotalsFilterAllowlist.OPS_BY_FIELD, CustomerStatusTotalsFilterAllowlist.DECIMAL_FIELDS, CustomerStatusTotalsFilterAllowlist.DURATION_FIELDS);
        if (filter.error() != null) {
            return ResponseEntity.badRequest().body(Map.of("error", filter.error(), "field", filter.field()));
        }
        List<FilterPredicate> filters = filter.predicates();
        List<CustomerStatusTotalsDto> rows = repository.list(requestedLimit != null ? requestedLimit : maxRows + 1, actualOffset, sortClause, filters);
        if (requestedLimit == null && rows.size() > maxRows) {
            return ResponseEntity.badRequest().body(Map.of("error", "report_too_large", "maxRows", maxRows));
        }
        if (withCount != null && withCount == 1) {
            long total = repository.count(filters);
            return ResponseEntity.ok(Map.of("rows", rows, "total", total));
        }
        return ResponseEntity.ok(rows);
    }

    /** A page bound as an integer of at least {@code min}, or null when it is not one. */
    private static Long parseBound(String raw, long min) {
        try {
            long n = Long.parseLong(raw);
            return n >= min ? n : null;
        } catch (NumberFormatException e) {
            return null;
        }
    }

    @PostMapping
    public ResponseEntity<?> create() {
        return methodNotAllowed("POST");
    }

    private static ResponseEntity<?> methodNotAllowed(String verb) {
        return ResponseEntity.status(HttpStatus.METHOD_NOT_ALLOWED)
                .body(Map.of("error", "method_not_allowed",
                        "message", verb + " is not supported on a report (read-only)."));
    }

    private static CustomerStatusTotalsRepository.SortClause parseSort(String raw) {
        String[] parts = raw.split(":", 2);
        if (parts.length == 0 || parts[0].isEmpty() || !SORT_ALLOWLIST.contains(parts[0])) return null;
        String dir = parts.length == 2 ? parts[1].toLowerCase()
            : SORT_DEFAULT_ORDER.getOrDefault(parts[0], "asc");
        if (!dir.equals("asc") && !dir.equals("desc")) return null;
        return new CustomerStatusTotalsRepository.SortClause(parts[0], dir);
    }
}
