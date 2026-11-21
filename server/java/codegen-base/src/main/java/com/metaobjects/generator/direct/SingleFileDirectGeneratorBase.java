package com.metaobjects.generator.direct;

import com.metaobjects.generator.GeneratorException;
import com.metaobjects.generator.MetaDataFilters;
import com.metaobjects.generator.GeneratorIOException;
import com.metaobjects.loader.MetaDataLoader;

import java.io.File;
import java.io.IOException;
import java.io.PrintWriter;

public abstract class SingleFileDirectGeneratorBase<T extends FileDirectWriter> extends DirectGeneratorBase {

    @Override
    public void execute( MetaDataLoader loader ) {

        String filename = null;
        PrintWriter pw = null;
        T writer = null;
        java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
        File outf = null;

        parseArgs();

        try {
            // Create output file
            filename = getOutputFilename();
            outf = new File(getOutputDir(), filename );

            // Get the printwriter
            pw = new PrintWriter(buffer);   // written below, and only when the bytes differ from what is on disk

            writer = getWriter(loader, pw);
            writer.withFilters(MetaDataFilters.create( getFilters() ))
                    .withFilename( outf.toString() );

            // Write the UML File
            writeFile(writer);
        }
        catch( IOException e ) {
            throw new GeneratorException( "Unable to write to file [" + filename + "]: " + e, e );
        }
        finally {
            if ( writer != null ) {
                try {
                    writer.close();
                } catch (IOException e) {
                    throw new GeneratorException( "Unable to close file [" + filename + "]: " + e, e );
                }
            }
            else if ( pw != null ) pw.close();
            if ( outf != null && pw != null ) {
                try {
                    com.metaobjects.generator.util.GeneratedFileWriter.writeUnmarked(outf.toPath(), buffer.toByteArray());
                } catch (IOException e) {
                    throw new GeneratorException( "Unable to write to file [" + filename + "]: " + e, e );
                }
            }
        }
    }

    protected abstract T getWriter( MetaDataLoader loader, PrintWriter pw ) throws GeneratorIOException;

    protected abstract void writeFile( T writer ) throws GeneratorIOException;
}
