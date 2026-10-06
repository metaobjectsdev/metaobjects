package com.metaobjects.generator.requirement;

import java.util.List;

/**
 * What a {@link RequirementTestRenderer} returns for one test: the Java source of that test,
 * and the imports it needs.
 *
 * @param imports names to import, each without {@code import} and the semicolon
 *                ({@code org.junit.jupiter.api.Assertions}, or {@code static org.x.Y.z}).
 *                May be empty.
 * @param source  the whole member that replaces the default one: any comments, annotations and
 *                the method. The generator indents every line and places it in the test class,
 *                where {@code witnesses} is the field holding the project's witness class, typed
 *                as that package's generated witness interface. The witness interface keeps a
 *                member for every non-skipped test whatever a renderer writes, so a renderer
 *                that wants the project's witness calls {@code witnesses.<witnessKey>()}.
 */
public record RenderedTest(List<String> imports, String source) {

    public RenderedTest {
        imports = imports == null ? List.of() : List.copyOf(imports);
        if (source == null) throw new IllegalArgumentException("a rendered test needs source");
    }
}
