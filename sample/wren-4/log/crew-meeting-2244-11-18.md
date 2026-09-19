# Crew meeting, 18 November 2244

- **When:** 09:00 station time, in the galley
- **Attendees:** Ada Quill (chair), Tomas Bray, MOTH-3 (minutes)
- **Absent:** Fresnel, asleep on the console

## Agenda

1. The outage on the 17th
2. Stores after the storm
3. Tender schedule
4. Any other business

## 1. The outage on the 17th

Quill walked through the [incident report](incident-2244-11-17.md). The beacon was dark for 27 minutes. No ship came to harm, and the tanker *Ormond Drift* held station until we were back.

- Root cause agreed: a single-event upset latched the amplifier controller at the height of the storm.
- The backup chain should have covered it and did not, because its cryocooler had been left cold since the October service.
- Bray asked whether the controller could be hardened aboard. Quill: no, it needs boards from the yard.

> **Decision:** the backup cryocooler stays in warm standby from today, and the weekly test keys the backup at full power for 60 seconds.

## 2. Stores after the storm

| Item | Before the storm | Now | Reorder at | Action |
| :--- | ---: | ---: | ---: | :--- |
| Amplifier controller boards | 2 each | 1 each | 2 each | Order 2 with the hardened firmware |
| Sensor-mast panes | 2 each | 1 each | 1 each | Order 1 |
| Coffee | 8 kg | 6 kg | 8 kg | Order 12 kg. Not negotiable. |
| Cat food | 30 tins | 22 tins | 30 tins | Order 60 tins |

Xenon and waveguide gaskets are also below their reorder levels and are already on the next tender. The full list is in [maintenance](../maintenance.md#stores).

## 3. Tender schedule

| Tender | Date | Carrying |
| :--- | :--- | :--- |
| Cancelled | 2244-11-16 | Nothing. Storm. |
| Next | 2244-12-05 | Controller boards, xenon, gaskets, the pane, coffee, cat food |
| After that | 2244-12-19 | Yard engineers for the fail-over watchdog |

## Decisions

1. Backup cryocooler in warm standby at all times.
2. Weekly test keys the backup at full power.
3. The station goes on storm routine whenever the forecast shows a CME within 48 hours.

## Action items

| # | Action | Owner | Due | Status |
| ---: | :--- | :--- | :--- | :--- |
| 1 | Put the backup cryocooler in warm standby | Bray | 2244-11-18 | Done |
| 2 | Add the full-power backup test to the weekly checklist | Quill | 2244-11-20 | Open |
| 3 | Order hardened controller boards | Quill | 2244-11-21 | Open |
| 4 | Fit the replacement sensor-mast pane | Bray | 2244-11-21 | Open |
| 5 | Send the storm write-up to the forecast office | MOTH-3 | 2244-11-22 | Open |

- [x] Minutes circulated
- [ ] Incident report countersigned by the yard
- [ ] Next meeting booked

## Parking lot

- Bray raised the unexplained narrowband signal again. The receiver logged it at 02:19, while the beacon was dark. Quill said it is not on the agenda. Bray asked for it to be minuted anyway. Minuted. See [signals](../signals.md).

**Next meeting:** 2244-11-25, 09:00, galley.
