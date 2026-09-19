# Wren-4 Beacon Station

The working repository for Wren-4, a fictional two-crew navigation beacon at the trailing Lagrange point of the gas giant Vesna c. Ships crossing the Oriel Belt steer by its pulse. Everything the station records lives here as Markdown: the log, the space weather, the eclipse schedule, the traffic, the signals and the noodles.

> [!IMPORTANT]
> **A note from Bray, for whoever reads this next.**
>
> Every 26 days since 2230, something out in the trailing cluster has sent this station a signal. Nobody knows what it is. Quill calls it instrument noise and has asked me to stop talking about it, so I am writing it down instead.
>
> If you want to find out, start with the *Unexplained narrowband* row on the [signals page](signals.md#detections). There is more hidden around this station than the documents table admits.

![Solar wind speed through November](charts/solar-wind-november.svg)

## At a glance

| | November 2244 |
| :--- | ---: |
| Beacon uptime | 99.938% |
| Minutes dark (unplanned) | 27 |
| Radio blackout hours | 13 |
| Ships logged | 271 |
| Peak solar wind | 981 km/s, 2244-11-17 |
| Crew dose this month | 853 µSv |
| Cats aboard | 1 |
| Cats on the manifest | 0 |
| Unexplained signals logged this year | 140 |

Solar wind this month: ▂▂▂▁▁▁▁▂▂▂▂▁▁▂▄▆█▆▄▂▂▁▁▂▁▂▁▁▁▁

## Documents

| Document | What is in it |
| :--- | :--- |
| [Station log, November](log/2244-11.md) | One row per day, the daily notes, the month's charts |
| [Crew meeting, 18 November](log/crew-meeting-2244-11-18.md) | The morning after the outage: decisions, stores, action items |
| [Incident: the beacon went dark](log/incident-2244-11-17.md) | Twenty-seven minutes of silence during a coronal mass ejection |
| [Beacon specification](beacon.md) | Pulse format, frequency plan, and the link budget with its maths |
| [Space weather](space-weather.md) | The year's table, the same data in four chart formats, the storm hour by hour |
| [Eclipses and power](eclipses.md) | Every eclipse this month as a `csv` block, and the battery through the storm |
| [Traffic](traffic.md) | Ships by class and day, where they were bound, the regulars |
| [Signals](signals.md) | Sixteen radio bands across twelve months, as a wide table and a heat map |
| [Maintenance](maintenance.md) | Stores, the work plan as a Gantt chart, the calibration schedule |
| [Beacon runbook](runbooks/beacon-silent.md) | What to do when the beacon will not transmit |
| [Noodles](noodles.md) | The only recipe aboard, scaled for 1 to 6 crew |

## Crew

| Name | Role | Aboard since | Notes |
| :--- | :--- | :---: | :--- |
| Ada Quill | Station chief | 2231 | Writes the log. Owns the good multimeter. |
| Tomas Bray | Systems technician | 2242 | Recalibrates the antenna more than it needs. |
| MOTH-3 | Maintenance drone | 2238 | Six legs, one opinion, several spare parts. |
| [Fresnel](crew/fresnel.md) | Cat | 2240 | Not on the manifest. Has never missed a watch. |

<!-- The documents table does not list every room. -->
