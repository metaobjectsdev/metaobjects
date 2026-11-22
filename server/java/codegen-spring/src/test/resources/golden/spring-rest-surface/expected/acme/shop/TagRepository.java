package acme.shop;

import com.metaobjects.generator.spring.runtime.FilterPredicate;
import java.util.List;
import java.util.Optional;

/**
 * GENERATED interface — consumer implements with their preferred persistence layer
 * (Spring Data JPA / jOOQ / plain JDBC). The matching TagController delegates to this interface.
 */
public interface TagRepository {
    /** Sort directive parsed from the cross-port ?sort=<field>:asc|desc grammar. */
    record SortClause(String field, String direction) {}

    List<TagDto> list(int limit, int offset, SortClause sort, List<FilterPredicate> filters);
    long count(List<FilterPredicate> filters);
    Optional<TagDto> findById(Long id);
    TagDto create(TagDto dto);
    Optional<TagDto> update(Long id, TagDto dto);
    Optional<TagDto> patch(Long id, TagPatch patch);
    boolean delete(Long id);
}
