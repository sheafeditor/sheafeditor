# Wren-4 Beacon Station

Wren-4 is a two-crew navigation beacon at the trailing Lagrange point of the gas giant Vesna c. Ships crossing the Oriel Belt steer by its pulse. This is everything the station knows, written down where the next crew can find it: the log, the space weather, the eclipse schedule, the traffic, the signals and the noodles.

![Wren-4 from the approach lane, Vesna c behind it](tour/panorama.svg)

> **A note from Bray, for whoever reads this next.**
>
> Every 26 days since 2230, something out in the trailing cluster has sent this station a signal. Nobody knows what it is. Quill calls it instrument noise and has asked me to stop talking about it, so I am writing it down instead.
>
> If you want to find out, start with the *Unexplained narrowband* row on the [signals page](signals.md#detections). There is more hidden around this station than the documents table admits.

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

![Solar wind speed through November](charts/solar-wind-november.svg)

## The station

<img src="tour/hab.svg" alt="The hab ring, fourteen windows and four spokes" width="640">

Fourteen windows, four spokes, one hub. Three of the windows have been shuttered since 2238. The hub does not turn, which is where you sleep and where the good chair is not.

## Standing orders

1. Two people for anything outside. No exceptions, and none have ever been asked for.
2. The beacon comes first. If you are choosing between the beacon and the hydroponics, shed the hydroponics.
3. Log the watch before you sleep, not after you wake. Quill will know.
4. If the beacon goes quiet, open the [runbook](runbooks/beacon-silent.md) before you open the panel.

The one command worth memorising, because it answers most of the questions the panel does:

```sh
beaconctl status --watch
```

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

<img src="tour/badge.svg" alt="The station badge" width="28"> Commissioned 2229, crewed continuously since.

| Name | Role | Aboard since | Notes |
| :--- | :--- | :---: | :--- |
| Ada Quill | Station chief | 2231 | Writes the log. Owns the good multimeter. |
| Tomas Bray | Systems technician | 2242 | Recalibrates the antenna more than it needs. |
| MOTH-3 | Maintenance drone | 2238 | Six legs, one opinion, several spare parts. |
| [Fresnel](crew/fresnel.md) | Cat | 2240 | Not on the manifest. Has never missed a watch. |

## How these files are kept

You will add to this, so here is what the conventions are. All of it is still text, and none of it needs a program this station does not already have.

> [!NOTE]
> A block written like this is a callout, and the runbook uses them for the steps that will bite you. It is the one piece of formatting worth reaching for when something is genuinely dangerous.

- Numbers you might want to sort, plot or hand to something else go in a `csv` block rather than a table. [Every eclipse this month](eclipses.md#every-eclipse-this-month) is kept that way, and so is the receiver log for the night of the 17th.
- Diagrams are written as Mermaid, so they still read as text when nothing is there to draw them. The [work plan](maintenance.md#work-plan) is a Gantt chart written in about twelve lines.
- Where the working matters more than the answer, write the working. The [link budget](beacon.md#link-budget) keeps the free-space term as $20\log_{10}(4\pi d / \lambda)$ rather than a number, because the number is wrong the moment the geometry moves.
- ==Highlight the one line that matters== instead of bolding half a paragraph. The incident report does it once, on the sentence the whole case rests on.
- A chart that needs its numbers beside it is Vega-Lite, which is what the [signals](signals.md) page uses.

Before you hand over to the crew after you:

- [ ] Read the runbook front to back, not the summary
- [ ] Walk the ring once with the outgoing chief
- [ ] Find out what the narrowband is

<!-- The documents table does not list every room. -->
