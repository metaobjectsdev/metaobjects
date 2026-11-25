- **Rust port: reports and projections are read (FR-044, ADR-0028).** The core crate derives a
  report's fields (`metaobjects::report_shape`, FR-044 Table B and C) byte for byte with
  `report-shapes.json`. A served read (a concrete projection or report whose read source is a view)
  gets a read-only struct in its model crate and a read-only module in its store crate: `list`,
  `count`, and `get` for a projection with a key. A view's numbers are read through a cast to their
  field's type, since the view's SQL picks the column type. The persistence runner now runs the 24
  report and 3 projection scenarios, and its ledger holds only the three many-to-many ones. A
  view-backed projection that an operation returns is now the model crate's type, not a copy in
  the contract crate. Clients and commands for read models wait for a Rust transport that serves
  them.
