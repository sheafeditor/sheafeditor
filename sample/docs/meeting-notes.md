# Platform sync — 2044-05-14

**Present:** scheduling, ingest, docs, on-call rotation
**Absent:** billing (holiday)
**Previous:** [2044-05-07](meeting-notes-2044-05-07.md)

---

## Agenda

1. RFC 0148 phase 3 readiness
2. Ingest backlog — still growing?
3. Docs freeze for the 2.5 release
4. On-call handover friction
5. AOB

---

## 1. RFC 0148 phase 3

Shadow mode has been clean for eleven days. Two divergences last week, both explained by the timetable edit that landed mid-run — not planner bugs.

- Publish cutover proposed for **Thu 2044-05-19, 06:00 UTC**, before the morning peak.
- Rollback is a flag flip; the old job stays warm for one cycle.
- Operations wants a dry-run email the evening before showing the schedules that would change.

> The thing that would actually reassure me is seeing zero diffs in the dry run. If the cutover changes any published schedule, I want to know why before Thursday.
>
> — Operations lead

**Decision:** cutover Thursday, conditional on a clean dry run Wednesday evening.

- [x] Wire the dry-run email — *scheduling*
- [ ] Confirm rollback flag works in staging — *scheduling*, due 05-16
- [ ] Notify support of the cutover window — *docs*, due 05-17

## 2. Ingest backlog

Backlog peaked at 4.1M messages on Sunday, down to 800K now, but the trough is rising week over week.

| Week ending | Peak backlog | Trough | Drain rate (msg/s) |
| :--- | ---: | ---: | ---: |
| 2044-04-26 | 2.9 M | 210 K | 9,400 |
| 2044-05-03 | 3.4 M | 380 K | 9,100 |
| 2044-05-10 | 4.1 M | 640 K | 8,700 |

Drain rate is falling while volume rises, which is the bad combination. Two candidate causes:

- Per-message validation got stricter in 2.4.1 and now allocates a schema object per message.
- The consumer group rebalances every ~90 s because one member's heartbeat is marginal.

**Decision:** profile before changing anything. Ingest to bring numbers to next week.

- [ ] CPU profile of a consumer under peak load — *ingest*, due 05-21
- [ ] Check heartbeat timings against the rebalance log — *ingest*, due 05-19

## 3. Docs freeze

Docs freeze **2044-05-26**, release **2044-06-02**. Anything not merged by the freeze ships in 2.6.

Outstanding:

- [x] API reference regenerated against 2.5 schema
- [ ] CLI tutorial screenshots are from 2.3 and show the old watch view — *docs*
- [ ] Migration note for cursor pagination — *docs*, blocked on the deprecation date
- [ ] Webhook signature example uses the old header name — *docs*

## 4. On-call handover

Recurring complaint: handover notes live in chat and are gone by the next rotation.

Proposal — a `handover.md` per rotation in the ops repo, with a fixed template:

```markdown
## Rotation 2044-W20 → W21

### Still open
- [ ] …

### Watch for
- …

### Noise you can ignore
- …
```

No objections. **Decision:** try it for two rotations, review 2044-05-28.

## 5. AOB

- Ingest asked whether anyone still reads the nightly digest email. Nobody in the room does. Parking it — someone outside the room might.
- Next sync **2044-05-21, 10:00 UTC**. Billing chairs.

---

## Actions summary

| Owner | Action | Due |
| :--- | :--- | :--- |
| scheduling | Confirm rollback flag in staging | 05-16 |
| docs | Notify support of cutover window | 05-17 |
| ingest | Heartbeat vs. rebalance log | 05-19 |
| ingest | CPU profile under peak | 05-21 |
| docs | Refresh tutorial screenshots | 05-26 |
