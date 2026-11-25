- **Local CI starts a lane only when the machine has the memory for it.** `scripts/ci-local.sh`
  holds a waiting lane until `MemAvailable` covers `MO_CI_LANE_MIN_FREE_MB` (default 8192) for
  it and for each lane started in the last 30 seconds. The first lane always starts, and `0`
  turns the check off. On a busy machine the parallel lanes had driven memory down to
  earlyoom's limit, and its SIGTERMs read as a crashed C# test host, SIGTERMed bun workers and
  a killed `rustc`, not as a memory problem. The SQLite and D1 report api-contract file now
  generates and boots one server per suite and reseeds in one batch, so it runs in about 46
  seconds instead of about 10 minutes, which no longer outlasts a 10-minute command cap.
