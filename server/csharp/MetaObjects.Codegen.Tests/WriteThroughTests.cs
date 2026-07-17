using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

/// <summary>
/// #214 (FR-024 §7) — write-through entity read-view codegen. A write-through entity
/// declares BOTH a writable table source AND a read-only replica view source, plus
/// derived (origin.*) fields. Because EF Core cannot map one CLR type to both a table
/// and a view, the write half (the table entity) is derived-FREE and a SECOND,
/// view-mapped read model carries the derived fields. Writes target the table; reads
/// (list / get / reverse finders) route to the view; a create/update re-reads the row
/// through the view by PK (read-your-writes).
/// </summary>
public class WriteThroughTests
{
    // Order: write-through (table orders + replica view v_order_with_customer) with a
    // derived customerName (origin.passthrough from Customer.name). Customer is a plain entity.
    private const string Model = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Customer", "children": [
        { "source.rdb": { "@kind": "table", "@table": "customers" } },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "name", "@required": true } },
        { "identity.primary": { "name": "pk", "@fields": "id" } }
      ]}},
      { "object.entity": { "name": "Order", "children": [
        { "source.rdb": { "@role": "primary", "@kind": "table", "@table": "orders" } },
        { "source.rdb": { "@role": "replica", "@kind": "view", "@view": "v_order_with_customer" } },
        { "field.long":   { "name": "id" } },
        { "field.long":   { "name": "customerId", "@required": true } },
        { "field.string": { "name": "customerName", "extends": "Customer.name", "children": [
          { "origin.passthrough": { "@from": "Customer.name" } }
        ]}},
        { "relationship.association": { "name": "customer", "@cardinality": "one", "@objectRef": "Customer" } },
        { "identity.primary":   { "name": "pk", "@fields": "id" } },
        { "identity.reference": { "name": "refCustomer", "@fields": "customerId", "@references": "Customer" } }
      ]}}
    ]}}
    """;

    private static MetaRoot Load()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "wt.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static GenContext Ctx(MetaRoot root) => new()
    {
        Entities = root.Objects(), Root = root,
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
    };

    private static string Src(IEnumerable<EmittedFile> files, string path) =>
        files.Single(f => f.Path == path).Content;

    // ---- Predicates -------------------------------------------------------------

    [Fact]
    public void Detects_write_through_and_replica_view_name()
    {
        var root = Load();
        var order = root.FindObject("Order")!;
        var customer = root.FindObject("Customer")!;

        Assert.True(order.IsWriteThrough());
        Assert.False(order.IsReadOnlyProjection());          // has a writable source too
        Assert.Equal("v_order_with_customer", order.ReplicaViewName);
        Assert.Null(order.DbView);                            // replica view is @role:replica, not primary
        Assert.Equal("orders", order.DbTable);

        Assert.False(customer.IsWriteThrough());              // plain entity
        Assert.True(order.FindField("customerName")!.IsDerived());
        Assert.False(order.FindField("customerId")!.IsDerived());
    }

    // ---- Entity generator: write entity (table, derived-free) -------------------

    [Fact]
    public void Write_entity_maps_table_and_excludes_derived_field()
    {
        var src = Src(new EntityGenerator().Generate(Ctx(Load())), "Order.g.cs");
        Assert.Contains("[Table(\"orders\")]", src);
        Assert.Contains("public class Order", src);
        Assert.Contains("public long Id { get; set; }", src);
        Assert.Contains("public long CustomerId { get; set; }", src);
        // Derived field lives ONLY on the view read model — never the write table.
        Assert.DoesNotContain("CustomerName", src);
    }

    // ---- Entity generator: read model (view, carries derived) -------------------

    [Fact]
    public void Read_model_is_view_mapped_and_carries_derived_field()
    {
        var files = new EntityGenerator().Generate(Ctx(Load()));
        var src = Src(files, "OrderView.g.cs");
        Assert.Contains("public class OrderView", src);
        Assert.DoesNotContain("[Table(", src);               // views carry no [Table]
        Assert.Contains("[Key]", src);                        // keyed (re-readable by PK)
        Assert.Contains("public long Id { get; set; }", src);
        Assert.Contains("CustomerName", src);                 // the derived field
    }

    // ---- DbContext: table DbSet + view DbSet + ToView ---------------------------

    [Fact]
    public void DbContext_registers_table_and_view_read_model()
    {
        var src = Assert.Single(new DbContextGenerator().Generate(Ctx(Load()))).Content;
        // The write entity is a normal table DbSet; the read model a view DbSet.
        Assert.Contains("public DbSet<Order> Orders { get; set; }", src);
        Assert.Contains("public DbSet<OrderView> OrderViews { get; set; }", src);
        // The read model maps to the replica view (keyed → no HasNoKey).
        Assert.Contains("modelBuilder.Entity<OrderView>().ToView(\"v_order_with_customer\");", src);
        Assert.DoesNotContain("modelBuilder.Entity<OrderView>().HasNoKey()", src);
    }

    // ---- Routes: reads → view DbSet, writes → table DbSet, re-read by PK --------

    [Fact]
    public void Routes_read_via_view_and_write_via_table()
    {
        var src = Src(new RoutesGenerator().Generate(Ctx(Load())), "OrderRoutes.g.cs");

        // Reads route to the view read model.
        Assert.Contains("IQueryable<OrderView> q = db.OrderViews.AsNoTracking();", src);
        Assert.Contains("await db.OrderViews.FindAsync(id) is { } found", src);

        // Writes target the table; a create re-reads the persisted row through the view.
        Assert.Contains("db.Orders.Add(input);", src);
        Assert.Contains("await db.OrderViews.FindAsync(input.Id)", src);
        // A create still binds the derived-FREE write entity (no derived-field create 400).
        Assert.Contains("app.MapPost", src);

        // The update handler finds the tracked write entity, then returns the re-read view row.
        Assert.Contains("var existing = await db.Orders.FindAsync(id);", src);
        Assert.Contains("var __view = await db.OrderViews.FindAsync(id);", src);

        // #214 [2] — an unrefreshed materialized / filtered replica view may not surface the
        // just-written row, so the re-read falls back to the write row: the 201/200 body is
        // NEVER null (degraded — missing only the derived fields; matches the Python port).
        Assert.Contains("(object?)__created ?? input", src);
        Assert.Contains("(object?)__view ?? existing", src);

        // The sort dispatch is typed on the read model (the list query is IQueryable<OrderView>).
        Assert.Contains("ApplySortOrder(IQueryable<OrderView> q", src);
    }

    // ---- Reverse finders are reads → route to the view DbSet --------------------

    [Fact]
    public void Reverse_finders_return_view_rows_from_view_dbset()
    {
        var src = Src(new EntityGenerator().Generate(Ctx(Load())), "OrderQueries.g.cs");
        Assert.Contains("Task<List<OrderView>> FindOrdersByCustomer(AppDbContext db", src);
        Assert.Contains("await db.OrderViews.AsNoTracking()", src);
    }

    // ---- A plain entity is untouched (byte-identical path) ----------------------

    [Fact]
    public void Vanilla_entity_is_unchanged()
    {
        var files = new EntityGenerator().Generate(Ctx(Load())).ToList();
        var customer = Src(files, "Customer.g.cs");
        Assert.Contains("[Table(\"customers\")]", customer);
        // No view read model is emitted for a plain entity.
        Assert.DoesNotContain(files, f => f.Path == "CustomerView.g.cs");
        var dbctx = Assert.Single(new DbContextGenerator().Generate(Ctx(Load()))).Content;
        Assert.DoesNotContain("CustomerView", dbctx);
    }
}
