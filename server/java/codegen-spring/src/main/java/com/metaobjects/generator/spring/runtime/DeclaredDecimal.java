package com.metaobjects.generator.spring.runtime;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * The declared {@code @precision} and {@code @scale} of a decimal record component (ADR-0019
 * Amendment 1, W3). The strict {@link CanonicalDecimalDeserializer} reads it from the property it
 * is bound to and refuses, with a {@code 400}, a value the column cannot hold: more fraction
 * digits than {@link #scale()}, or more integer digits than {@code precision - scale}. Trailing
 * zeros do not count (the number {@code 1.50000000000} has one fraction digit) and nothing is
 * ever rounded.
 *
 * <p>The generated DTO, patch and value-object records carry it on a component that declares
 * {@code @precision}; a component without it is bounded only by the engine-wide W3 limits.</p>
 */
@Documented
@Retention(RetentionPolicy.RUNTIME)
@Target({ElementType.RECORD_COMPONENT, ElementType.PARAMETER, ElementType.FIELD, ElementType.METHOD})
public @interface DeclaredDecimal {
    /** Total significant digits the column holds. */
    int precision();

    /** Digits after the decimal point the column holds. */
    int scale();
}
