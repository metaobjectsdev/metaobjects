- **codegen-ts: a generator declares what it provides in one place.** `provides` on a `Generator`
  (`entityModule`, `queries`, `names`, `reportExport`, `routes` with its framework, `expose` and
  `filter`, `uiTier`, `modelDocs`, `apiDocs`) replaces the nine single-purpose markers
  (`emitsEntityModule`, `emitsQueries`, `emitsNames`, `emitsReportExport`, `emitsHonoRoutes`,
  `mountsRoutes`, `emitsUiTier`, `emitsModelDocs`, `emitsApiDocs`). The runner, the docs
  generators and the gates read it through one function, `providesOf`, so a generator of your own
  under any name is seen as the stock one is. The old markers are deprecated and still read, so an
  owned copy that sets them keeps working; a re-ejected copy declares `provides`.
