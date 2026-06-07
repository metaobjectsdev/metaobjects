package com.metaobjects.generator.apidocs;
import org.junit.Test;
import java.util.List;
import static org.junit.Assert.assertEquals;
public class JavaApiModelTypesTest {
  @Test public void recordsCompose() {
    FieldShape f = new FieldShape("id", "Long", false, null);
    ApiSymbol s = new ApiSymbol("AuthorDto", ApiSymbolKind.DTO, "acme.blog.AuthorDto",
        "record AuthorDto(Long id, String name)", List.of(), "the wire/validation shape",
        null, null, null, List.of(f));
    ApiUnit u = new ApiUnit("Author", "acme.blog", "entity", List.of(s), null);
    JavaApiModel m = new JavaApiModel("acme-blog", List.of(u));
    assertEquals(ApiSymbolKind.DTO, m.units().get(0).symbols().get(0).kind());
    assertEquals("id", s.fields().get(0).name());
    assertEquals(false, f.optional());
  }
}
