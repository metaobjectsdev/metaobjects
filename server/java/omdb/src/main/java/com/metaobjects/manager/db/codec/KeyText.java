/*
 * Copyright 2026 Doug Mealing LLC dba Meta Objects
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.metaobjects.manager.db.codec;

import com.metaobjects.field.CurrencyField;
import com.metaobjects.field.DecimalField;
import com.metaobjects.field.DoubleField;
import com.metaobjects.field.FloatField;
import com.metaobjects.field.IntegerField;
import com.metaobjects.field.LongField;
import com.metaobjects.field.MetaField;

import java.math.BigDecimal;

/**
 * The one reader of numeric key text (an {@code objectref://} id)
 * into the numeric type its field declares.
 *
 * <p>Text is accepted only in canonical decimal form: an optional {@code -}, ASCII digits with
 * no leading zero (a lone {@code 0} is fine), never {@code -0}; a decimal-valued field may
 * add {@code .} and at least one ASCII digit. No {@code +}, whitespace, hex, octal, binary,
 * exponent, underscore, non-ASCII digit, {@code 1.} or {@code .5}. The characters are checked
 * one by one: {@code Character.isDigit} and {@code Long.parseLong} both accept text that is no
 * key (Unicode digits, {@code +1}). A refusal is an {@link IllegalArgumentException}, the type
 * {@code ObjectRef} already throws for a malformed id, and its message names the entity and
 * field but never the text.</p>
 */
public final class KeyText {

    private KeyText() {}

    /** True when {@code f} is a numeric field whose key text {@link #coerce} reads. */
    public static boolean isNumeric(MetaField f) {
        return f instanceof IntegerField || f instanceof LongField || f instanceof CurrencyField
                || f instanceof DecimalField || f instanceof DoubleField || f instanceof FloatField;
    }

    /**
     * Reads {@code text} as the numeric type {@code f} declares, or returns it unchanged when
     * {@code f} is not numeric (a string or uuid key is never reinterpreted).
     */
    public static Object coerce(MetaField f, String text) {
        if (!isNumeric(f)) return text;
        boolean fractional = f instanceof DecimalField || f instanceof DoubleField || f instanceof FloatField;
        if (!canonical(text, fractional)) throw refuse(f);
        try {
            if (f instanceof IntegerField) return Integer.valueOf(Integer.parseInt(text));
            if (f instanceof LongField || f instanceof CurrencyField) return Long.valueOf(Long.parseLong(text));
            if (f instanceof DecimalField) return new BigDecimal(text);
            if (f instanceof DoubleField) {
                double d = Double.parseDouble(text);
                if (Double.isInfinite(d)) throw refuse(f); // canonical text too large for the type
                return Double.valueOf(d);
            }
            float v = Float.parseFloat(text);
            if (Float.isInfinite(v)) throw refuse(f);
            return Float.valueOf(v);
        } catch (NumberFormatException e) { // canonical text that overflows the declared type
            throw refuse(f);
        }
    }

    /** Canonical decimal text: see the class comment. */
    static boolean canonical(String s, boolean fractional) {
        if (s == null) return false;
        int n = s.length(), i = 0;
        boolean negative = n > 0 && s.charAt(0) == '-';
        if (negative) i = 1;
        int intStart = i;
        while (i < n && isAsciiDigit(s.charAt(i))) i++;
        int intLen = i - intStart;
        if (intLen == 0) return false;
        if (intLen > 1 && s.charAt(intStart) == '0') return false;
        boolean zero = intLen == 1 && s.charAt(intStart) == '0';
        if (i == n) return !(negative && zero);
        if (!fractional || s.charAt(i) != '.') return false;
        i++;
        int fracStart = i;
        boolean allZero = zero;
        while (i < n && isAsciiDigit(s.charAt(i))) {
            if (s.charAt(i) != '0') allZero = false;
            i++;
        }
        if (i == n && i > fracStart) return !(negative && allZero);
        return false;
    }

    private static boolean isAsciiDigit(char c) {
        return c >= '0' && c <= '9';
    }

    private static IllegalArgumentException refuse(MetaField f) {
        String entity = f.getParent() == null ? "?" : f.getParent().getName();
        return new IllegalArgumentException("Invalid key for field [" + entity + "." + f.getName()
                + "]: expected canonical decimal text of the field's declared numeric type");
    }
}
