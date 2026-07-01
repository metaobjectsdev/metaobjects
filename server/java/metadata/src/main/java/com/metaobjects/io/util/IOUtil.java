package com.metaobjects.io.util;

import com.metaobjects.MetaData;
import com.metaobjects.MetaDataAware;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;

public class IOUtil {

    public static MetaObject getMetaObjectFor(MetaDataLoader loader, Object o) {
        if ( o instanceof MetaDataAware ) return (MetaObject) ((MetaDataAware<?>) o).getMetaData();
        return loader.getMetaObjectFor( o );
    }

    public static String toCamelCase( String text, boolean capitalizeFirstChar ) {

        if (text == null || text.isEmpty()) {
            return text;
        }

        StringBuilder converted = new StringBuilder();

        boolean first = true;
        boolean convertNext = false;
        for (char ch : text.toCharArray()) {
            if (ch == '-') {
                convertNext = true;
            }
            else if (convertNext) {
                ch = Character.toTitleCase(ch);
                convertNext = false;
                converted.append(ch);
            }
            else if (first && capitalizeFirstChar) {
                ch = Character.toTitleCase(ch);
                converted.append(ch);
            }
            else {
                converted.append(ch);
            }
            if ( first ) first = false;
        }

        return converted.toString();
    }

    public static List<String> getUniquePackages(Collection<? extends MetaData> filtered ) throws IOException {
        List<String> pkgs = new ArrayList<>();

        filtered.forEach( md -> {
            if ( md instanceof MetaObject
                    && !pkgs.contains( md.getPackage() )) {
                pkgs.add( md.getPackage() );
            }
        });

        return pkgs;
    }

    public static boolean isAbstract( MetaData md ) {
        // ADR-0039: @isAbstract is a declaration-layer marker — describes THIS
        // declaration and must NOT be inherited (a concrete node extending an abstract
        // base is itself concrete). Own-only read; matches the canonical abstract
        // contract in ValidationPhase + CanonicalJsonSerializer.
        if ( md.hasMetaAttr(MetaData.ATTR_IS_ABSTRACT, false)
                && Boolean.TRUE.equals( md.getMetaAttr( MetaData.ATTR_IS_ABSTRACT, false ).getValue())) {
            return true;
        }
        return false;
    }
}
