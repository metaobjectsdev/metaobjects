// A reference declared on an ABSTRACT TPH intermediate must reach the finalized EF model.
//
// The DbContext's TPH pass read the concrete subtypes' OWN identities only, so a reference an
// abstract level between the discriminator base and its leaves declares was configured on no
// type at all: the FK column existed, EF knew no relationship over it, and the referential
// action and constraint name the metadata declares were silently dropped. Read back out of the
// model EF builds from the generated code (model-only: no database), with abstract shapes on
// (the intermediate is a class) and off (its fields are folded into each leaf).

using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;
using Xunit;

namespace MetaObjects.IntegrationTests;

public sealed class TphIntermediateReferenceEfModelTests
{
    private const string Model = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Workflow", "children": [
        { "source.rdb": { "@table": "workflows" } },
        { "field.long":   { "name": "id" } },
        { "identity.primary": { "@fields": "id", "@generation": "increment" } }
      ]}},
      { "object.entity": { "name": "Job", "@discriminator": "kind", "children": [
        { "source.rdb": { "@table": "jobs" } },
        { "field.long":   { "name": "id" } },
        { "field.enum":   { "name": "kind", "@values": ["Call", "Urgent", "Mail", "Plain"] } },
        { "identity.primary": { "@fields": "id", "@generation": "increment" } }
      ]}},
      { "object.entity": { "name": "CaseJob", "extends": "Job", "abstract": true, "children": [
        { "field.long":   { "name": "workflowId" } },
        { "field.enum":   { "name": "stage", "@values": ["Open", "Closed"] } },
        { "field.decimal": { "name": "fee", "@precision": 8, "@scale": 2 } },
        { "identity.reference": { "name": "refWorkflow", "@fields": "workflowId", "@references": "Workflow",
          "@onDelete": "cascade", "@constraintName": "fk_jobs_workflow" } }
      ]}},
      { "object.entity": { "name": "CallJob", "extends": "CaseJob", "@discriminatorValue": "Call", "children": [
        { "field.string": { "name": "phone", "@maxLength": 20 } }
      ]}},
      { "object.entity": { "name": "UrgentCallJob", "extends": "CallJob", "@discriminatorValue": "Urgent", "children": [
        { "field.int": { "name": "priority" } }
      ]}},
      { "object.entity": { "name": "MailJob", "extends": "CaseJob", "@discriminatorValue": "Mail", "children": [
        { "field.string": { "name": "address", "@maxLength": 120 } }
      ]}},
      { "object.entity": { "name": "PlainJob", "extends": "Job", "@discriminatorValue": "Plain", "children": [
        { "field.string": { "name": "memo", "@maxLength": 40 } }
      ]}}
    ]}}
    """;

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void Reference_on_abstract_tph_intermediate_reaches_the_ef_model(bool shapes)
    {
        var gen = GeneratedEfModel.Compile(Model, "Acme.TphMid" + (shapes ? "Shapes" : "Plain"),
            c => c with { EmitAbstractShapes = shapes });
        using var db = gen.ModelOnlyContext();

        // UrgentCallJob is concrete under concrete CallJob: it inherits CallJob's foreign key, and
        // must not get a second one of its own.
        foreach (var leaf in new[] { "CallJob", "UrgentCallJob", "MailJob" })
        {
            var type = Assert.Single(db.Model.GetEntityTypes(), t => t.ClrType.Name == leaf);
            var fk = Assert.Single(type.GetForeignKeys(), k => k.Properties.Select(p => p.Name).SequenceEqual(["WorkflowId"]));
            Assert.Equal("Workflow", fk.PrincipalEntityType.ClrType.Name);
            Assert.Equal(DeleteBehavior.Cascade, fk.DeleteBehavior);
            Assert.Equal("fk_jobs_workflow", fk.GetConstraintName());
            // The intermediate's other fields keep the configuration the leaves' builders give them,
            // whether or not the intermediate is now part of the EF hierarchy.
            Assert.Equal(typeof(string), type.FindProperty("Stage")!.GetTypeMapping().Converter?.ProviderClrType);
            Assert.Equal(8, type.FindProperty("Fee")!.GetPrecision());
        }
        // A leaf outside the intermediate does not carry it.
        var plain = Assert.Single(db.Model.GetEntityTypes(), t => t.ClrType.Name == "PlainJob");
        Assert.DoesNotContain(plain.GetForeignKeys(), k => k.Properties.Any(p => p.Name == "WorkflowId"));
    }
}
