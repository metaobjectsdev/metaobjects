package com.metaobjects.validation;

import com.metaobjects.MetaData;

import java.util.ArrayList;
import java.util.List;

/**
 * The context handed to every validator: the symbol table for cross-reference resolution
 * plus an error sink. Collecting (rather than eager-throwing) lets one load report all
 * problems; the loader decides whether to throw the first (back-compat) or surface all.
 */
public final class ValidationContext {

    private final SymbolTable symbols;
    private final List<ValidationError> errors = new ArrayList<>();

    public ValidationContext(SymbolTable symbols) {
        this.symbols = symbols;
    }

    public SymbolTable symbols() {
        return symbols;
    }

    public List<ValidationError> errors() {
        return errors;
    }

    public void error(String code, MetaData node, String message) {
        errors.add(new ValidationError(code, message, node.getSource()));
    }
}
