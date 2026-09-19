# Platform sync — 2044-05-07

**Present:** scheduling, ingest, docs, billing
**Absent:** on-call rotation (incident)
**Next:** [2044-05-14](meeting-notes.md)

---

## 1. RFC 0148 shadow mode

Day four. Two divergences, both from exception ordering. Scheduling is fixing the ordering rule rather than the planner.

**Decision:** keep shadow running through the weekend; revisit cutover next week.

- [x] Document the ordering rule in the RFC — *scheduling*
- [ ] Re-run the divergence report after the fix — *scheduling*, due 05-10

## 2. Ingest backlog

Backlog peaked at 3.4M Sunday. Nobody has looked at why yet.

**Decision:** carry over.

## 3. Berth 6

Works are running two days late. Operations expects it back **2044-05-09**, which puts OTP recovery in next week's numbers rather than this week's.

## 4. AOB

- Billing asked for a schedule-diff export. Scheduling will build a CSV export.
- Next sync **2044-05-14, 10:00 UTC**.

---

## Actions summary

| Owner | Action | Due |
| :--- | :--- | :--- |
| scheduling | Re-run divergence report | 05-10 |
| scheduling | Schedule-diff CSV export | 05-17 |
| ingest | Bring backlog numbers | 05-14 |
