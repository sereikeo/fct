// TODO: Cash engine
// 1. Load budget_items from SQLite (exclude deleted_at)
// 2. Expand recurring items into dated entries across from..to range
// 3. Apply envelope_overrides
// 4. Apply reconciliation deltas
// 5. Bundle CC items (payment='Credit') → single deduction on CC_STMT_DUE_DAY
// 6. Compute running balP / balM / bal day-by-day from FCT_OPENING_BALANCE
// Returns CashFlowEntry[]
