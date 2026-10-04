package com.metaobjects.view;

import com.metaobjects.registry.MetaDataRegistry;

import java.util.List;

/**
 * The generic web-presentation view controls ({@code view.text},
 * {@code view.dropdown}, ...).
 *
 * <p>They are registered so a metadata document that carries them LOADS in the
 * Java port, as it does in every other port. They stay TS-web-PRESENTATION-ONLY:
 * no Java codegen, render or runtime consumer reads them, and the registry
 * manifest excludes them ({@code RegistryManifest}, {@code PRESENTATION_ONLY}).
 * One class serves every control kind because a view carries no per-subtype
 * behavior here.</p>
 *
 * <p>Mirrors {@code VIEW_SUBTYPES} in the TypeScript
 * {@code presentation/view/view-constants.ts}.</p>
 */
public class PresentationView extends MetaView {

    public static final String SUBTYPE_TEXT = "text";
    public static final String SUBTYPE_TEXTAREA = "textarea";
    public static final String SUBTYPE_DATE = "date";
    public static final String SUBTYPE_MONTH = "month";
    public static final String SUBTYPE_HOTLINK = "hotlink";
    public static final String SUBTYPE_DROPDOWN = "dropdown";
    public static final String SUBTYPE_RADIO = "radio";
    public static final String SUBTYPE_CHECKBOX = "checkbox";
    public static final String SUBTYPE_NUMBER = "number";
    public static final String SUBTYPE_PASSWORD = "password";
    public static final String SUBTYPE_HIDDEN = "hidden";
    public static final String SUBTYPE_WEB = "web";
    public static final String SUBTYPE_IMAGE = "image";

    /** Every generic presentation control kind, in the TypeScript declaration order. */
    public static final List<String> SUBTYPES = List.of(
        SUBTYPE_TEXT, SUBTYPE_TEXTAREA, SUBTYPE_DATE, SUBTYPE_MONTH, SUBTYPE_HOTLINK,
        SUBTYPE_DROPDOWN, SUBTYPE_RADIO, SUBTYPE_CHECKBOX, SUBTYPE_NUMBER, SUBTYPE_PASSWORD,
        SUBTYPE_HIDDEN, SUBTYPE_WEB, SUBTYPE_IMAGE);

    public PresentationView(String type, String subType, String name) {
        super(type, subType, name);
    }

    public static void registerTypes(MetaDataRegistry registry) {
        for (String subType : SUBTYPES) {
            registry.registerType(PresentationView.class, def -> def
                .type(TYPE_VIEW).subType(subType)
                .description("Web presentation control (" + subType + ") — loads in every port; "
                    + "consumed by the TypeScript web client only")
                .inheritsFrom(TYPE_VIEW, SUBTYPE_BASE));
        }
    }
}
