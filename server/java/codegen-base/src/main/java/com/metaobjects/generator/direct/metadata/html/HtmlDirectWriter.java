package com.metaobjects.generator.direct.metadata.html;

import com.metaobjects.generator.GeneratorIOException;
import com.metaobjects.generator.GeneratorIOWriter;
import com.metaobjects.loader.MetaDataLoader;

/**
 * Base class for HTML direct writers: what {@link SingleHtmlDirectGeneratorBase} drives. This is
 * the HTML equivalent of {@code JsonDirectWriter}. The base names this type and not a writer
 * that emits a particular page, so a generator copied out with {@code mvn metaobjects:eject}
 * pairs with the copy of its own writer.
 */
public abstract class HtmlDirectWriter<T extends HtmlDirectWriter> extends GeneratorIOWriter<T> {

    public HtmlDirectWriter(MetaDataLoader loader) throws GeneratorIOException {
        super(loader);
    }

    /** Write the whole page to the stream the writer was given. */
    public abstract void writeHtml() throws GeneratorIOException;
}
