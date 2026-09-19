---
title: Corridor operations — weekly report
period: 2044-W19 (2044-05-06 → 2044-05-12)
owner: operations
distribution: internal-sample
---

# Corridor operations — weekly report, 2044-W19

Numbers-first document: small dense tables, fenced data blocks, and short interpretive notes between them. Nothing here is prose for its own sake.

**Headline:** on-time performance recovered to 91.4% (+3.1 pts) after the berth-6 works finished. Cancellations flat. Fuel cost per crossing up 4% on price, not consumption.

---

## 1. Service performance

| Route | Sailings | On time | Delayed >10m | Cancelled | OTP | Δ vs W18 |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| NW-14 | 168 | 156 | 10 | 2 | 92.9% | +4.2 |
| NW-22 | 140 | 124 | 14 | 2 | 88.6% | +1.8 |
| SE-03 | 98 | 92 | 6 | 0 | 93.9% | +2.0 |
| SE-08 | 84 | 74 | 8 | 2 | 88.1% | −0.6 |
| CE-01 | 126 | 118 | 7 | 1 | 93.7% | +5.4 |
| CE-05 | 112 | 100 | 11 | 1 | 89.3% | +3.3 |
| **Total** | **728** | **664** | **56** | **8** | **91.2%** | **+3.1** |

SE-08 is the only route moving the wrong way. Two of its three worst days coincided with the CE-05 vessel swap, which suggests shared crew rather than anything route-specific.

### Delay causes

| Cause | Incidents | Minutes lost | Share |
| :--- | ---: | ---: | ---: |
| Berth unavailable | 14 | 402 | 31.8% |
| Late inbound connection | 11 | 288 | 22.8% |
| Weather | 9 | 246 | 19.5% |
| Loading overrun | 12 | 190 | 15.0% |
| Technical | 5 | 98 | 7.8% |
| Other / unrecorded | 5 | 39 | 3.1% |
| **Total** | **56** | **1,263** | **100%** |

"Berth unavailable" halved week over week and should keep falling now that berth 6 is back.

## 2. Daily detail

```csv
date,route,sailings,on_time,delayed,cancelled,pax,vehicles,load_factor
2044-05-06,NW-14,24,23,1,0,9840,1980,0.85
2044-05-06,NW-22,20,18,2,0,6210,1410,0.74
2044-05-06,SE-03,14,14,0,0,3980,760,0.81
2044-05-06,SE-08,12,11,1,0,3110,690,0.77
2044-05-06,CE-01,18,18,0,0,5420,1120,0.79
2044-05-06,CE-05,16,15,1,0,4870,990,0.82
2044-05-07,NW-14,24,22,2,0,10120,2040,0.88
2044-05-07,NW-22,20,17,3,0,6480,1390,0.77
2044-05-07,SE-03,14,13,1,0,4110,790,0.84
2044-05-07,SE-08,12,10,2,0,3240,700,0.80
2044-05-07,CE-01,18,17,1,0,5610,1150,0.82
2044-05-07,CE-05,16,14,2,0,5020,1010,0.85
2044-05-08,NW-14,24,23,1,0,9640,1930,0.83
2044-05-08,NW-22,20,18,1,1,6050,1360,0.72
2044-05-08,SE-03,14,14,0,0,3890,740,0.79
2044-05-08,SE-08,12,11,1,0,3020,670,0.75
2044-05-08,CE-01,18,17,1,0,5380,1110,0.78
2044-05-08,CE-05,16,15,1,0,4790,970,0.80
2044-05-09,NW-14,24,22,2,0,10310,2080,0.89
2044-05-09,NW-22,20,17,2,1,6720,1440,0.80
2044-05-09,SE-03,14,13,1,0,4240,810,0.86
2044-05-09,SE-08,12,10,2,0,3380,720,0.84
2044-05-09,CE-01,18,17,1,0,5740,1180,0.84
2044-05-09,CE-05,16,14,2,0,5180,1040,0.88
2044-05-10,NW-14,24,22,1,1,10890,2190,0.94
2044-05-10,NW-22,20,18,2,0,7010,1490,0.83
2044-05-10,SE-03,14,14,0,0,4390,840,0.89
2044-05-10,SE-08,12,11,1,0,3510,750,0.87
2044-05-10,CE-01,18,17,1,0,5980,1230,0.87
2044-05-10,CE-05,16,15,1,0,5340,1080,0.90
2044-05-11,NW-14,24,22,2,0,11240,2260,0.97
2044-05-11,NW-22,20,18,2,0,7280,1540,0.87
2044-05-11,SE-03,14,13,1,0,4520,870,0.92
2044-05-11,SE-08,12,11,1,0,3640,780,0.90
2044-05-11,CE-01,18,17,1,0,6110,1260,0.89
2044-05-11,CE-05,16,14,2,0,5490,1110,0.92
2044-05-12,NW-14,24,22,1,1,10480,2110,0.90
2044-05-12,NW-22,20,18,2,0,6840,1450,0.81
2044-05-12,SE-03,14,11,3,0,4180,800,0.85
2044-05-12,SE-08,12,10,2,0,3290,700,0.81
2044-05-12,CE-01,18,15,2,1,5620,1160,0.82
2044-05-12,CE-05,16,13,2,1,5010,1010,0.84
```

## 3. Capacity and load

| Route | Pax capacity | Pax carried | Load factor | Vehicle deck | Vehicles | Deck use |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| NW-14 | 80,640 | 72,520 | 89.9% | 16,128 | 14,590 | 90.5% |
| NW-22 | 61,600 | 46,590 | 75.6% | 12,320 | 10,080 | 81.8% |
| SE-03 | 34,300 | 29,310 | 85.5% | 6,860 | 5,610 | 81.8% |
| SE-08 | 29,400 | 23,190 | 78.9% | 5,880 | 5,010 | 85.2% |
| CE-01 | 47,880 | 39,860 | 83.2% | 9,576 | 8,210 | 85.7% |
| CE-05 | 42,560 | 35,700 | 83.9% | 8,512 | 7,210 | 84.7% |

Vehicle decks are the binding constraint on NW-14 four days out of seven. Adding passenger capacity there would not sell.

## 4. Cost

| Line | This week | Last week | Δ | Δ% |
| :--- | ---: | ---: | ---: | ---: |
| Fuel | 412,880 | 396,410 | +16,470 | +4.2% |
| Crew | 288,140 | 291,900 | −3,760 | −1.3% |
| Port dues | 96,220 | 94,100 | +2,120 | +2.3% |
| Maintenance | 61,470 | 118,300 | −56,830 | −48.0% |
| Other | 34,910 | 33,800 | +1,110 | +3.3% |
| **Total** | **893,620** | **934,510** | **−40,890** | **−4.4%** |

Maintenance fell because the berth-6 works closed out. Fuel is up on price — consumption per crossing was flat at 1.92 t, within noise of the 1.90 t four-week mean.

## 5. Open items

- [x] Berth 6 returned to service (2044-05-09)
- [x] CE-05 vessel swap completed
- [ ] SE-08 crew rostering review — **due 2044-05-20**, owner: operations
- [ ] Fuel hedge review with finance — **due 2044-05-27**
- [ ] Retire the manual daily tally once the CLI export is signed off

## 6. Notes

> The vehicle-deck constraint on NW-14 is now the single largest revenue ceiling in the corridor. Worth a proper look before the summer timetable is fixed.
>
> — Operations lead, 2044-05-12
