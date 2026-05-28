package com.metaobjects.render.templategen;

import com.metaobjects.render.Provider;
import com.metaobjects.render.RenderRequest;
import com.metaobjects.render.Renderer;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;

/**
 * Java port of the rc.12 cross-port {@code templateGenerator()} factory.
 *
 * <p>Walks a caller-supplied root via the walk callback, renders the shared
 * Mustache template via {@link Renderer#render}, and returns
 * {@code List<EmittedFile>} — one entry per walk result.
 *
 * <p>The root type is generic ({@code <R>}) so this factory does not pull
 * the metadata package into the render module's dependency graph — the
 * walk callback knows the actual root type at the call site (typically
 * {@code com.metaobjects.MetaRoot}, but conformance tests can use any
 * test-shape).
 *
 * <p>Design: {@code spec/design-docs/2026-05-28-cross-port-template-generator.md}.
 * Cross-port byte-equivalence verified via the shared fixture corpus at
 * {@code fixtures/render-conformance/template-generator/}.
 *
 * <p>Note: this factory does NOT implement the legacy
 * {@code com.metaobjects.generator.Generator} interface — that interface
 * has {@code void execute(MetaDataLoader)} which doesn't fit the
 * declarative "return files" cross-port shape. Adopters who want Maven
 * plugin integration can wrap this factory in their own
 * legacy-Generator-conformant glue.
 */
public final class TemplateGenerator {

    private TemplateGenerator() {}

    /** Convenience static factory mirroring TS/Python/C# signatures. */
    public static <R> List<EmittedFile> generate(
            String name,
            String template,
            Function<R, List<TemplateWalkResult>> walk,
            Provider provider,
            String format,
            R root) {
        Renderer renderer = new Renderer();
        List<EmittedFile> out = new ArrayList<>();
        for (TemplateWalkResult entry : walk.apply(root)) {
            RenderRequest req = new RenderRequest(
                /* template */ null,
                /* ref */ template,
                /* payload */ entry.data(),
                /* provider */ provider,
                /* format */ format,
                /* verify */ null,
                /* maxChars */ null);
            String content = renderer.render(req);
            out.add(new EmittedFile(entry.outputPath(), content));
        }
        return out;
    }

    /** Overload defaulting format to "text". */
    public static <R> List<EmittedFile> generate(
            String name,
            String template,
            Function<R, List<TemplateWalkResult>> walk,
            Provider provider,
            R root) {
        return generate(name, template, walk, provider, "text", root);
    }
}
