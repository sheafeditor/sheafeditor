---
rfc: 0148
title: Deterministic sailing schedules
status: Accepted
authors: [Platform Working Group]
created: 2044-02-14
updated: 2044-04-30
supersedes: [RFC 0092]
---

# RFC 0148 — Deterministic sailing schedules

**Status:** Accepted · **Discussion:** [#0148](https://example.com/rfcs/148) · **Supersedes:** RFC 0092

## Summary

Schedules are currently produced by a nightly job whose output depends on the order rows come back from the database. Two runs over identical inputs can disagree. This RFC replaces that job with a pure function from `(timetable, fleet, exceptions)` to a schedule, and makes the result content-addressed so that "did the schedule change?" is a hash comparison rather than a diff.

## Motivation

Three problems, in order of how much they cost us:

1. **Nondeterminism.** Re-running the generator over the same inputs produces different vessel assignments about 1 run in 6. Operations cannot tell an intentional change from noise, so they stopped reading the diff.
2. **No provenance.** Given a published schedule, there is no way to recover which timetable revision and which exception set produced it.
3. **Late failure.** Capacity conflicts surface at publish time, hours after the inputs that caused them were edited.

> We currently detect double-booked vessels by a customer telling us.
>
> — Postmortem 2043-11-02

## Goals

- Same inputs → byte-identical output, on any machine, in any order.
- Every published schedule names its inputs by hash.
- Conflicts are detected at edit time, not at publish time.

### Non-goals

- Changing the timetable data model. This RFC consumes it as-is.
- Optimising vessel assignment for cost. Assignment stays first-fit; only its determinism changes.
- Real-time re-planning during disruptions. That is RFC 0151's problem.

## Design

### Overview

```
timetable.yaml ─┐
fleet.yaml     ─┼──▶ plan(inputs) ──▶ Schedule ──▶ publish
exceptions.yaml─┘         │
                          └──▶ conflicts[]  ──▶ editor diagnostics
```

`plan` is total and pure: no clock, no randomness, no I/O. Every ordering it depends on is derived from a stable sort key defined below.

### Stable ordering

The single rule that makes the output deterministic:

> Any collection iterated during planning is first sorted by its **sort key** — the tuple `(departs_at, route_code, service_id)` — which is unique by construction.

Uniqueness is enforced at load time. Duplicate keys are an input error, not something the planner resolves.

### The schedule identity

A schedule's ID is `blake3` over the canonical JSON encoding of its inputs:

```ts
export function scheduleId(inputs: PlannerInputs): string {
  const canonical = JSON.stringify(inputs, Object.keys(inputs).sort());
  return blake3(canonical).toString('hex').slice(0, 16);
}
```

Two consequences worth stating plainly:

- Publishing a schedule whose ID already exists is a no-op, so retries are free.
- A changed ID always means a changed input. It never means "the job ran again".

### Conflict detection

Conflicts are computed during planning and returned alongside the schedule rather than thrown:

| Conflict | Severity | Detected when | Blocks publish? |
| :--- | :--- | :--- | :---: |
| `vessel_double_booked` | error | Two sailings overlap on one vessel | Yes |
| `turnaround_too_short` | error | Gap below the vessel's minimum | Yes |
| `crew_hours_exceeded` | error | Duty period over the statutory cap | Yes |
| `berth_contention` | warning | Two vessels want one berth within 10 min | No |
| `low_utilisation` | info | Projected load under 15% | No |
| `exception_unused` | info | An exception matched nothing | No |

Errors block publish. Warnings and info are surfaced in the editor and recorded on the schedule.

### Exceptions

Exceptions are applied in file order after the base timetable expands, each one narrowing or replacing a window:

```yaml
exceptions:
  - id: ex-summer-extra
    match: { route: NW-14, weekday: [sat, sun] }
    between: [2044-06-15, 2044-08-20]
    action: add
    sailings:
      - departs: "21:30"
        vessel: ves_81

  - id: ex-drydock-44
    match: { vessel: ves_44 }
    between: [2044-09-01, 2044-09-21]
    action: remove
```

An exception that matches nothing is reported as `exception_unused` rather than silently ignored — the common editing mistake is a typo'd route code.

## Rollout

1. **Phase 1 (2 weeks).** Run the new planner in shadow mode. Compare against the current job; log divergences. No user-visible change.
2. **Phase 2 (2 weeks).** Editor diagnostics go live. Conflicts are visible but do not block.
3. **Phase 3.** Publishing switches to the new planner. The old job stays behind a flag for one cycle.
4. **Phase 4.** Old job deleted, flag removed.

- [x] Phase 1 complete — 3 divergence classes found, all traced to the ordering bug
- [x] Phase 2 complete
- [ ] Phase 3 — scheduled for 2044-05-19
- [ ] Phase 4

## Alternatives considered

**Sort the database query and stop there.** Cheapest option, and it fixes the immediate nondeterminism. Rejected because it leaves provenance and late-failure untouched, and because the next person to add a `Map` iteration reintroduces the bug with nothing to catch it.

**Constraint solver.** Genuinely better assignments — an estimated 4–7% fewer vessel-hours in a prototype. Rejected for now: solver output is not stable across library versions, which trades our nondeterminism for someone else's, and the operations team could not explain a solver's assignment to a customer.

**Snapshot the output and diff it.** Detects change without fixing the cause. Useful anyway, and it is what Phase 1 does, but it is not a design.

## Open questions

1. Should `exception_unused` be an error in CI even though it is info in the editor?
2. How long do we keep superseded schedules addressable — indefinitely, or one season?
3. Does the sort key survive routes that legitimately share a code across operators?[^operators]

[^operators]: Two operators do share `NW-14` historically. The load-time uniqueness check currently rejects this. Either the key grows an operator field or the data gets cleaned up; the working group prefers cleaning up the data.

## Appendix A — Canonical JSON

Canonical encoding is: object keys sorted bytewise, no insignificant whitespace, numbers in shortest round-trip form, strings in NFC. This is deliberately not JCS — we do not need its number handling and did not want the dependency.

## Appendix B — Measured impact

| Metric | Before | After (shadow) | Change |
| :--- | ---: | ---: | ---: |
| Planning wall time (p50) | 41.2 s | 12.8 s | −69% |
| Planning wall time (p99) | 190.4 s | 21.7 s | −89% |
| Reruns disagreeing | 16.4% | 0.0% | — |
| Conflicts found before publish | 0 | 37 | — |
| Peak RSS | 1.9 GB | 640 MB | −66% |
