package com.metaobjects.generator.direct.metadata.html;

import com.metaobjects.generator.GeneratorIOException;
import com.metaobjects.generator.GeneratorTestBase;
import com.metaobjects.loader.MetaDataLoader;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * A subclass written before the base drove {@link HtmlDirectWriter} overrode
 * {@code writeHtml(MetaDataHtmlDocumentationWriter)}. It has to keep being called.
 */
public class SingleHtmlBaseHookCompatTest extends GeneratorTestBase {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    /** The shape of a pre-1.1 subclass: stock writer in both signatures. */
    @SuppressWarnings("deprecation")
    static final class OldStyleGenerator extends SingleHtmlDirectGeneratorBase {
        int hookCalls;

        @Override
        protected MetaDataHtmlDocumentationWriter getWriter(MetaDataLoader loader, OutputStream os)
                throws GeneratorIOException {
            return new MetaDataHtmlDocumentationWriter(loader, os);
        }

        @Override
        protected void writeHtml(MetaDataHtmlDocumentationWriter writer) throws GeneratorIOException {
            hookCalls++;
            writer.writeHtml();
        }
    }

    @Test
    public void anOverrideOfTheOldHookIsStillCalled() throws Exception {
        OldStyleGenerator generator = new OldStyleGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", tmp.getRoot().getAbsolutePath());
        args.put("outputFilename", "old.html");
        generator.setArgs(args);
        MetaDataLoader loader = new MetaDataLoader(com.metaobjects.loader.LoaderOptions.create(false, false, true),
                MetaDataLoader.SUBTYPE_MANUAL, "htmlHookCompat");
        loader.init();

        generator.execute(loader);

        assertEquals("the old hook ran once", 1, generator.hookCalls);
        assertTrue(new java.io.File(tmp.getRoot(), "old.html").length() > 0);
    }
}
