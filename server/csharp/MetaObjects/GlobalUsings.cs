// Metamodel-constants barrel (ADR-0003 §3).
//
// Constants now live with the concern that owns them (Shared/, Core/*, Persistence/*,
// Presentation/*). These `global using static` directives re-expose every concern's
// constants as bare names across the assembly — the C# realization of the
// "barrel preserves the convenient import surface" point in ADR-0003. The colocated
// definition in each concern remains the single source of truth.
//
// Each constant name carries its concern prefix (FIELD_ATTR_*, SOURCE_SUBTYPE_*, ...),
// so exposing them all globally introduces no ambiguity.

global using static MetaObjects.Shared.BaseTypes;
global using static MetaObjects.Shared.Structural;
global using static MetaObjects.Core.Attr.AttrConstants;
global using static MetaObjects.Core.Documentation.DocumentationConstants;
global using static MetaObjects.Core.Query.QueryConstants;
global using static MetaObjects.Core.Field.FieldConstants;
global using static MetaObjects.Core.Object.ObjectConstants;
global using static MetaObjects.Core.Validator.ValidatorConstants;
global using static MetaObjects.Core.Identity.IdentityConstants;
global using static MetaObjects.Core.Relationship.RelationshipConstants;
global using static MetaObjects.Persistence.Source.SourceConstants;
global using static MetaObjects.Persistence.Origin.OriginConstants;
global using static MetaObjects.Persistence.Db.DbConstants;
global using static MetaObjects.Presentation.View.ViewConstants;
global using static MetaObjects.Presentation.Layout.LayoutConstants;
global using static MetaObjects.Template.TemplateConstants;
