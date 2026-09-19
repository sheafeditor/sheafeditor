# Large Tables

Table rendering under load. Three shapes that fail in different ways: many rows, many columns, and cells whose content is wider than the column.

Scrolling should stay smooth, the header row should keep its alignment against the body, and clicking any cell should start editing that cell and no other.

## Tall — 800 rows × 12 columns

The common “export from a job runner” shape. Mixed alignment: numeric columns right, identifiers left.

| # | Job ID | Name | Owner | Region | State | Attempts | Duration (s) | Rows in | Rows out | Cost | Updated |
| ---: | :--- | :--- | :--- | :--- | :--- | ---: | ---: | ---: | ---: | ---: | :--- |
| 1 | job-997900 | immutable-replica-13 | docs | North | blocked | 5 | 3417.6 | 4,615,034 | 2,435,672 | $72.99 | 2044-12-26 |
| 2 | job-561254 | sparse-index-8 | billing | Offshore | skipped | 1 | 285.3 | 887,414 | 650,959 | $339.81 | 2044-05-16 |
| 3 | job-926852 | idle-transcript-26 | infra | Central | running | 7 | 3381.5 | 3,648,650 | 1,687,782 | $385.88 | 2044-12-02 |
| 4 | job-453614 | idle-queue-8 | growth | South | failed | 7 | 1136.7 | 1,871,935 | 1,041,167 | $241.96 | 2044-04-16 |
| 5 | job-863425 | idle-replica-25 | docs | Offshore | running | 7 | 32.9 | 1,597,680 | 1,122,116 | $391.49 | 2044-02-02 |
| 6 | job-264931 | inbound-pipeline-24 | billing | East | blocked | 5 | 2973.1 | 1,286,553 | 1,003,194 | $152.67 | 2044-01-14 |
| 7 | job-937960 | durable-buffer-27 | platform | North | running | 6 | 2257.8 | 2,881,092 | 204,085 | $21.35 | 2044-02-28 |
| 8 | job-286236 | ephemeral-buffer-12 | billing | South | queued | 6 | 621.8 | 4,674,902 | 485,147 | $243.58 | 2044-12-20 |
| 9 | job-592403 | warm-gateway-32 | infra | West | queued | 4 | 1920.9 | 560,763 | 78,011 | $5.53 | 2044-01-20 |
| 10 | job-002517 | ephemeral-checkpoint-1 | docs | East | queued | 3 | 806.6 | 3,399,779 | 1,270,244 | $219.90 | 2044-12-23 |
| 11 | job-130424 | canonical-transcript-9 | growth | South | skipped | 2 | 2992.2 | 954,513 | 138,670 | $182.73 | 2044-06-09 |
| 12 | job-885606 | derived-batch-8 | search | West | failed | 5 | 361.6 | 4,010,694 | 41,040 | $326.47 | 2044-12-26 |
| 13 | job-962454 | inbound-queue-34 | search | North | queued | 8 | 2057.6 | 2,673,665 | 2,011,400 | $88.18 | 2044-02-14 |
| 14 | job-601343 | contended-checkpoint-16 | platform | West | running | 4 | 552.7 | 195,274 | 128,071 | $193.73 | 2044-10-05 |
| 15 | job-544386 | nested-queue-8 | growth | South | queued | 9 | 1125.9 | 848,016 | 788,742 | $126.97 | 2044-08-18 |
| 16 | job-747033 | delayed-replica-29 | billing | Central | skipped | 6 | 553.8 | 3,431,158 | 2,154,780 | $231.52 | 2044-02-20 |
| 17 | job-371418 | ephemeral-cache-8 | docs | East | running | 5 | 1623.9 | 3,065,998 | 37,018 | $136.20 | 2044-10-22 |
| 18 | job-161152 | nested-transcript-30 | docs | South | queued | 3 | 1272.3 | 4,580,463 | 292,448 | $38.36 | 2044-11-28 |
| 19 | job-895008 | partial-ledger-17 | docs | Central | failed | 9 | 1825.8 | 1,147,571 | 903,103 | $108.69 | 2044-01-09 |
| 20 | job-297731 | ephemeral-replica-26 | docs | East | failed | 9 | 805.2 | 2,384,230 | 1,024,540 | $159.01 | 2044-08-22 |
| 21 | job-948868 | idle-replica-12 | billing | Central | running | 5 | 2444.4 | 4,709,580 | 3,555,469 | $297.57 | 2044-01-12 |
| 22 | job-429026 | idle-scheduler-5 | docs | South | blocked | 3 | 307.9 | 2,868,245 | 333,451 | $129.39 | 2044-06-06 |
| 23 | job-480044 | contended-buffer-30 | search | Central | done | 6 | 683.7 | 595,728 | 387,158 | $19.21 | 2044-02-12 |
| 24 | job-914246 | idle-lease-21 | docs | Central | failed | 7 | 1047.9 | 3,659,481 | 350,544 | $131.69 | 2044-01-17 |
| 25 | job-372688 | idle-lease-21 | docs | West | queued | 4 | 338.0 | 3,957,964 | 3,032,537 | $101.52 | 2044-01-17 |
| 26 | job-639152 | partial-queue-37 | billing | Central | running | 2 | 2074.2 | 1,868,468 | 1,233,150 | $213.91 | 2044-06-17 |
| 27 | job-437888 | stale-quota-36 | ingest | West | blocked | 6 | 1929.6 | 4,880,893 | 460,565 | $102.53 | 2044-04-19 |
| 28 | job-059153 | ephemeral-checkpoint-1 | billing | East | failed | 9 | 1425.7 | 2,777,389 | 2,329,877 | $183.92 | 2044-12-25 |
| 29 | job-610651 | immutable-gateway-31 | billing | West | blocked | 1 | 875.6 | 2,340,065 | 1,693,179 | $92.66 | 2044-12-07 |
| 30 | job-870106 | idle-cursor-15 | growth | Offshore | done | 3 | 1388.5 | 4,044,961 | 1,286,762 | $102.54 | 2044-04-21 |
| 31 | job-578327 | warm-transcript-28 | billing | Central | queued | 4 | 1658.9 | 3,090,475 | 1,633,233 | $159.68 | 2044-01-15 |
| 32 | job-192408 | canonical-partition-10 | docs | West | queued | 5 | 167.3 | 3,096,438 | 2,607,951 | $190.01 | 2044-01-27 |
| 33 | job-432777 | contended-queue-4 | infra | Central | failed | 3 | 2129.2 | 1,507,311 | 975,807 | $138.20 | 2044-01-23 |
| 34 | job-468069 | idle-envelope-31 | billing | West | running | 3 | 1325.0 | 1,699,078 | 1,373,016 | $390.19 | 2044-10-11 |
| 35 | job-705357 | sparse-replica-25 | infra | South | queued | 4 | 1627.2 | 2,374,515 | 2,259,603 | $294.38 | 2044-08-01 |
| 36 | job-138432 | contended-index-6 | docs | South | blocked | 4 | 2089.3 | 2,047,231 | 722,149 | $35.38 | 2044-01-01 |
| 37 | job-603302 | partial-batch-24 | docs | Central | skipped | 2 | 1686.1 | 482,580 | 420,783 | $111.06 | 2044-04-19 |
| 38 | job-311429 | immutable-ledger-2 | ingest | Offshore | queued | 9 | 1102.7 | 438,053 | 377,658 | $367.78 | 2044-03-26 |
| 39 | job-854776 | stale-digest-13 | platform | South | running | 4 | 1734.2 | 2,180,357 | 942,954 | $205.18 | 2044-07-01 |
| 40 | job-277210 | derived-pipeline-37 | ingest | West | blocked | 8 | 1805.7 | 1,514,775 | 1,157,975 | $254.31 | 2044-04-11 |
| 41 | job-731639 | durable-replica-28 | platform | West | blocked | 8 | 3442.7 | 1,464,576 | 428,450 | $162.84 | 2044-08-17 |
| 42 | job-973374 | delayed-registry-4 | search | South | blocked | 3 | 360.9 | 4,126,849 | 693,833 | $376.80 | 2044-04-18 |
| 43 | job-205425 | orphaned-buffer-33 | search | South | done | 1 | 3100.8 | 4,936,851 | 3,940,157 | $249.03 | 2044-12-18 |
| 44 | job-028759 | inbound-checkpoint-31 | infra | East | done | 6 | 2733.7 | 4,878,875 | 2,295,640 | $61.15 | 2044-04-04 |
| 45 | job-763478 | canonical-gateway-16 | docs | North | running | 9 | 1446.1 | 4,603,639 | 148,522 | $382.05 | 2044-10-08 |
| 46 | job-358831 | durable-buffer-10 | growth | West | failed | 2 | 2261.9 | 4,444,727 | 3,706,056 | $32.59 | 2044-09-19 |
| 47 | job-695836 | nested-transcript-40 | platform | South | failed | 8 | 1772.7 | 2,827,808 | 1,966,500 | $389.08 | 2044-08-14 |
| 48 | job-287497 | orphaned-lease-5 | docs | North | running | 9 | 1773.6 | 1,463,304 | 1,211,303 | $42.21 | 2044-06-01 |
| 49 | job-765079 | contended-digest-14 | search | South | queued | 8 | 1975.5 | 778,713 | 210,178 | $55.62 | 2044-11-25 |
| 50 | job-563503 | orphaned-digest-13 | growth | Central | skipped | 2 | 910.7 | 2,527,756 | 1,469,849 | $69.05 | 2044-05-16 |
| 51 | job-451491 | durable-cursor-14 | ingest | South | failed | 4 | 2058.3 | 4,946,687 | 1,279,837 | $75.75 | 2044-10-21 |
| 52 | job-534797 | idle-shard-16 | infra | North | done | 2 | 1115.8 | 957,167 | 317,461 | $50.39 | 2044-12-13 |
| 53 | job-471772 | orphaned-buffer-15 | docs | South | queued | 3 | 1754.1 | 2,197,479 | 1,259,924 | $126.30 | 2044-07-15 |
| 54 | job-613613 | derived-replica-1 | billing | North | failed | 6 | 3561.2 | 2,176,405 | 426,599 | $212.68 | 2044-02-01 |
| 55 | job-000187 | warm-ledger-30 | growth | South | failed | 9 | 721.8 | 2,873,692 | 2,071,958 | $147.95 | 2044-05-11 |
| 56 | job-533450 | durable-cache-19 | docs | Central | queued | 2 | 2371.2 | 2,989,773 | 460,129 | $228.65 | 2044-06-23 |
| 57 | job-642620 | partial-scheduler-35 | search | Offshore | queued | 2 | 2343.1 | 1,338,198 | 446,636 | $15.68 | 2044-04-28 |
| 58 | job-431831 | orphaned-pipeline-2 | growth | South | skipped | 6 | 3406.1 | 1,657,993 | 1,256,599 | $79.38 | 2044-07-15 |
| 59 | job-440199 | sparse-digest-27 | ingest | West | skipped | 8 | 1461.5 | 3,472,862 | 1,899,247 | $129.66 | 2044-06-10 |
| 60 | job-264833 | canonical-pipeline-32 | billing | South | failed | 9 | 3179.7 | 2,536,234 | 1,856,469 | $334.25 | 2044-05-19 |
| 61 | job-481388 | warm-shard-2 | docs | South | failed | 6 | 407.5 | 856,323 | 319,673 | $187.26 | 2044-05-27 |
| 62 | job-214999 | orphaned-partition-31 | docs | South | blocked | 7 | 1679.8 | 1,767,020 | 1,471,352 | $151.63 | 2044-01-01 |
| 63 | job-383985 | inbound-pipeline-34 | billing | South | blocked | 6 | 865.4 | 3,047,101 | 2,736,176 | $154.12 | 2044-02-11 |
| 64 | job-515042 | partial-checkpoint-38 | search | East | skipped | 2 | 2257.9 | 104,050 | 81,466 | $137.21 | 2044-05-01 |
| 65 | job-658603 | canonical-buffer-4 | growth | North | skipped | 9 | 1260.6 | 2,153,919 | 495,556 | $98.90 | 2044-08-21 |
| 66 | job-126053 | idle-cache-28 | billing | Central | done | 4 | 2861.9 | 1,278,569 | 741,057 | $360.02 | 2044-02-08 |
| 67 | job-535913 | durable-registry-34 | platform | East | queued | 7 | 2218.8 | 4,343,216 | 1,792,144 | $253.43 | 2044-09-28 |
| 68 | job-344282 | orphaned-scheduler-40 | infra | East | queued | 6 | 202.6 | 175,733 | 160,113 | $176.84 | 2044-04-28 |
| 69 | job-784608 | nested-pipeline-1 | search | West | skipped | 3 | 893.0 | 3,218,632 | 2,498,683 | $301.57 | 2044-07-09 |
| 70 | job-305679 | idle-replica-35 | billing | Central | skipped | 6 | 868.3 | 1,029,381 | 314,909 | $186.69 | 2044-11-28 |
| 71 | job-379865 | contended-scheduler-40 | infra | South | done | 5 | 1648.5 | 2,219,198 | 304,446 | $104.70 | 2044-03-21 |
| 72 | job-521209 | inbound-lease-31 | ingest | West | failed | 3 | 3472.3 | 645,104 | 100,884 | $51.82 | 2044-10-25 |
| 73 | job-766154 | inbound-namespace-23 | search | South | skipped | 2 | 1112.2 | 903,676 | 853,000 | $123.33 | 2044-12-05 |
| 74 | job-084497 | delayed-buffer-7 | infra | East | blocked | 3 | 3272.2 | 1,872,267 | 1,042,324 | $302.59 | 2044-06-18 |
| 75 | job-509147 | idle-envelope-35 | platform | North | done | 8 | 1047.3 | 3,239,207 | 2,291,932 | $124.26 | 2044-01-24 |
| 76 | job-243215 | contended-digest-4 | docs | West | skipped | 8 | 3385.4 | 2,242,235 | 1,650,006 | $208.91 | 2044-02-12 |
| 77 | job-093364 | warm-gateway-26 | growth | South | done | 5 | 1689.7 | 986,154 | 760,956 | $64.07 | 2044-02-13 |
| 78 | job-838196 | delayed-pipeline-29 | platform | Central | skipped | 4 | 563.8 | 543,393 | 170,680 | $194.10 | 2044-10-01 |
| 79 | job-343138 | canonical-ledger-40 | growth | North | done | 2 | 350.9 | 2,696,744 | 1,236,095 | $260.38 | 2044-12-10 |
| 80 | job-791472 | idle-shard-36 | growth | South | queued | 3 | 2762.7 | 4,279,564 | 4,055,394 | $305.78 | 2044-03-24 |
| 81 | job-841677 | inbound-ledger-38 | infra | Offshore | running | 5 | 2742.1 | 4,722,458 | 3,907,064 | $140.08 | 2044-05-06 |
| 82 | job-915293 | nested-checkpoint-9 | docs | Central | queued | 4 | 870.3 | 2,152,135 | 1,271,470 | $288.28 | 2044-12-23 |
| 83 | job-790616 | nested-batch-9 | growth | Central | done | 5 | 1494.1 | 424,441 | 254,870 | $35.98 | 2044-02-09 |
| 84 | job-412017 | warm-cache-5 | search | North | running | 2 | 651.2 | 3,332,380 | 2,467,087 | $245.18 | 2044-05-26 |
| 85 | job-351182 | warm-quota-39 | growth | South | failed | 3 | 1910.7 | 4,872,596 | 591,038 | $37.50 | 2044-05-28 |
| 86 | job-243260 | idle-transcript-6 | growth | Central | skipped | 1 | 156.3 | 3,022,923 | 2,099,474 | $125.04 | 2044-03-27 |
| 87 | job-564181 | ephemeral-buffer-6 | billing | East | failed | 3 | 2497.2 | 2,991,554 | 1,193,529 | $148.58 | 2044-11-09 |
| 88 | job-329356 | durable-snapshot-7 | growth | North | failed | 7 | 3287.7 | 4,053,208 | 186,836 | $114.08 | 2044-02-10 |
| 89 | job-135224 | sparse-envelope-40 | billing | Central | blocked | 5 | 575.1 | 417,062 | 115,046 | $154.86 | 2044-05-18 |
| 90 | job-587116 | orphaned-namespace-1 | platform | West | done | 6 | 1766.5 | 2,341,023 | 1,138,245 | $220.19 | 2044-10-13 |
| 91 | job-809824 | derived-pipeline-16 | search | West | done | 4 | 2823.7 | 4,448,089 | 1,352,510 | $45.86 | 2044-03-08 |
| 92 | job-683620 | sparse-pipeline-40 | platform | Offshore | queued | 7 | 630.0 | 3,991,962 | 1,338,377 | $359.96 | 2044-03-01 |
| 93 | job-234724 | inbound-partition-11 | billing | East | queued | 7 | 2265.1 | 3,134,250 | 1,434,778 | $41.13 | 2044-01-27 |
| 94 | job-231825 | durable-cache-14 | infra | South | failed | 6 | 1063.6 | 1,765,665 | 14,315 | $175.44 | 2044-01-26 |
| 95 | job-490282 | inbound-index-22 | growth | North | running | 3 | 1727.9 | 3,929,136 | 2,004,531 | $27.17 | 2044-01-02 |
| 96 | job-320865 | durable-replica-17 | ingest | South | failed | 2 | 1825.2 | 2,545,670 | 1,368,187 | $219.95 | 2044-06-21 |
| 97 | job-724339 | durable-snapshot-13 | docs | South | failed | 4 | 652.1 | 1,699,421 | 223,059 | $373.16 | 2044-12-11 |
| 98 | job-842059 | derived-manifest-21 | docs | Offshore | running | 9 | 1421.3 | 452,963 | 143,775 | $353.08 | 2044-11-03 |
| 99 | job-652570 | contended-transcript-14 | billing | West | done | 8 | 46.3 | 4,406,001 | 2,050,404 | $243.60 | 2044-02-05 |
| 100 | job-227557 | nested-quota-6 | infra | Offshore | queued | 4 | 36.4 | 4,953,716 | 1,246,142 | $136.16 | 2044-02-09 |
| 101 | job-097799 | durable-ledger-4 | growth | South | done | 6 | 2582.8 | 2,737,776 | 822,292 | $11.73 | 2044-03-21 |
| 102 | job-803619 | contended-namespace-1 | billing | North | running | 3 | 1631.1 | 539,525 | 66,973 | $271.20 | 2044-05-12 |
| 103 | job-311528 | nested-namespace-11 | billing | Offshore | skipped | 7 | 673.3 | 3,390,045 | 3,312,508 | $228.89 | 2044-02-27 |
| 104 | job-477175 | ephemeral-cursor-7 | docs | North | failed | 5 | 2233.8 | 1,303,853 | 650,951 | $0.36 | 2044-12-08 |
| 105 | job-563893 | nested-shard-7 | growth | East | failed | 9 | 3544.1 | 653,829 | 395,261 | $37.65 | 2044-04-02 |
| 106 | job-165674 | orphaned-batch-18 | infra | Central | failed | 5 | 3218.5 | 4,684,326 | 2,830,353 | $13.66 | 2044-03-07 |
| 107 | job-232286 | derived-transcript-2 | search | Central | blocked | 4 | 2674.0 | 4,540,839 | 4,448,383 | $108.44 | 2044-11-25 |
| 108 | job-693668 | inbound-manifest-30 | ingest | East | failed | 9 | 1735.2 | 1,559,843 | 735,966 | $335.35 | 2044-07-08 |
| 109 | job-259380 | ephemeral-queue-2 | search | West | done | 3 | 717.5 | 1,044,627 | 310,453 | $129.79 | 2044-08-19 |
| 110 | job-456577 | stale-manifest-3 | infra | Central | done | 4 | 263.2 | 4,740,115 | 46,900 | $139.82 | 2044-02-23 |
| 111 | job-559746 | orphaned-batch-5 | docs | South | skipped | 6 | 2776.5 | 1,441,977 | 1,024,447 | $70.53 | 2044-01-08 |
| 112 | job-012443 | nested-lease-9 | platform | South | blocked | 2 | 2233.8 | 4,228,565 | 3,461,247 | $179.05 | 2044-01-27 |
| 113 | job-995781 | immutable-lease-3 | ingest | North | failed | 6 | 2420.1 | 3,885,951 | 3,132,454 | $272.94 | 2044-10-19 |
| 114 | job-471217 | delayed-replica-33 | infra | North | running | 9 | 2939.3 | 3,743,644 | 2,001,725 | $98.97 | 2044-07-17 |
| 115 | job-494152 | canonical-partition-36 | platform | South | queued | 4 | 2290.0 | 1,236,423 | 1,074,437 | $342.31 | 2044-09-23 |
| 116 | job-637970 | canonical-batch-40 | infra | Offshore | running | 5 | 2607.8 | 2,833,776 | 2,216,309 | $83.85 | 2044-05-06 |
| 117 | job-257117 | idle-queue-12 | infra | Central | skipped | 5 | 791.8 | 134,872 | 123,448 | $111.51 | 2044-11-12 |
| 118 | job-642898 | derived-queue-6 | platform | Central | running | 9 | 2021.0 | 1,838,957 | 1,733,047 | $309.25 | 2044-06-14 |
| 119 | job-856248 | stale-cursor-37 | infra | East | queued | 1 | 2911.3 | 3,915,353 | 670,013 | $161.16 | 2044-01-28 |
| 120 | job-868377 | durable-snapshot-35 | infra | Offshore | blocked | 1 | 2546.5 | 509,720 | 235,251 | $292.49 | 2044-04-03 |
| 121 | job-326018 | idle-cursor-15 | billing | Central | queued | 2 | 2884.9 | 4,295,205 | 240,950 | $379.41 | 2044-11-22 |
| 122 | job-149725 | contended-buffer-31 | search | East | queued | 9 | 3195.6 | 3,541,757 | 236,171 | $378.78 | 2044-10-11 |
| 123 | job-538515 | ephemeral-registry-5 | growth | West | failed | 5 | 721.9 | 3,880,752 | 2,840,450 | $300.68 | 2044-06-02 |
| 124 | job-807864 | nested-pipeline-5 | docs | West | failed | 1 | 2076.5 | 4,392,316 | 1,830,359 | $287.18 | 2044-12-23 |
| 125 | job-962186 | canonical-manifest-16 | docs | North | running | 6 | 651.1 | 4,036,482 | 1,422,863 | $38.50 | 2044-10-21 |
| 126 | job-308130 | partial-quota-30 | platform | South | done | 7 | 749.1 | 23,764 | 9,467 | $131.71 | 2044-02-13 |
| 127 | job-773561 | canonical-queue-7 | billing | North | skipped | 7 | 765.2 | 1,750,409 | 1,204,634 | $291.85 | 2044-06-26 |
| 128 | job-115195 | partial-snapshot-34 | search | South | running | 7 | 2644.2 | 2,586,493 | 830,720 | $68.68 | 2044-01-24 |
| 129 | job-912271 | orphaned-registry-8 | platform | South | skipped | 6 | 960.8 | 4,795,476 | 1,721,239 | $332.71 | 2044-11-28 |
| 130 | job-355074 | ephemeral-pipeline-11 | search | West | blocked | 6 | 1666.1 | 2,246,278 | 1,024,782 | $259.38 | 2044-08-17 |
| 131 | job-122252 | stale-checkpoint-12 | platform | West | queued | 2 | 2073.2 | 505,683 | 450,639 | $128.53 | 2044-06-22 |
| 132 | job-129691 | orphaned-partition-37 | infra | Offshore | skipped | 5 | 3266.7 | 2,462,770 | 2,087,790 | $171.00 | 2044-04-12 |
| 133 | job-330715 | durable-lease-33 | search | East | queued | 3 | 1324.8 | 1,515,436 | 254,905 | $318.75 | 2044-04-09 |
| 134 | job-666769 | contended-quota-39 | search | North | skipped | 7 | 1465.7 | 3,103,421 | 2,605,074 | $60.25 | 2044-03-12 |
| 135 | job-893008 | contended-ledger-3 | docs | East | running | 2 | 1626.3 | 2,183,108 | 1,805,093 | $105.10 | 2044-09-24 |
| 136 | job-260843 | warm-checkpoint-39 | ingest | South | skipped | 1 | 878.4 | 4,716,686 | 3,287,689 | $341.81 | 2044-10-02 |
| 137 | job-306163 | idle-manifest-2 | ingest | Offshore | blocked | 5 | 1554.4 | 39,521 | 2,528 | $241.60 | 2044-01-28 |
| 138 | job-742355 | derived-cache-3 | growth | Offshore | done | 1 | 2054.4 | 826,834 | 823,357 | $85.78 | 2044-05-28 |
| 139 | job-704781 | ephemeral-scheduler-36 | infra | West | running | 8 | 74.7 | 1,527,868 | 1,407,002 | $21.43 | 2044-09-07 |
| 140 | job-916956 | canonical-checkpoint-30 | growth | North | queued | 7 | 2802.3 | 4,131,471 | 2,133,387 | $245.40 | 2044-04-11 |
| 141 | job-434678 | durable-manifest-25 | growth | South | blocked | 4 | 739.3 | 3,038,694 | 2,737,135 | $22.72 | 2044-04-14 |
| 142 | job-623926 | inbound-manifest-13 | ingest | South | failed | 5 | 1052.5 | 4,848,073 | 2,954,019 | $380.51 | 2044-12-14 |
| 143 | job-816467 | durable-index-9 | ingest | East | failed | 7 | 3347.2 | 1,908,119 | 546,948 | $184.65 | 2044-06-11 |
| 144 | job-278099 | warm-digest-11 | infra | East | failed | 5 | 2204.1 | 584,147 | 278,861 | $345.10 | 2044-08-17 |
| 145 | job-994566 | durable-ledger-29 | growth | East | skipped | 7 | 1312.9 | 1,878,638 | 1,475,274 | $329.98 | 2044-04-28 |
| 146 | job-963769 | contended-partition-14 | billing | North | done | 2 | 485.5 | 3,906,453 | 1,919,754 | $369.63 | 2044-04-13 |
| 147 | job-430993 | delayed-replica-40 | infra | East | failed | 7 | 253.6 | 4,332,758 | 1,681,099 | $273.11 | 2044-06-04 |
| 148 | job-200224 | warm-digest-9 | docs | South | running | 4 | 99.6 | 1,007,804 | 185,670 | $169.96 | 2044-02-13 |
| 149 | job-876177 | immutable-lease-24 | search | East | done | 4 | 1401.8 | 4,757,417 | 2,844,711 | $158.20 | 2044-05-14 |
| 150 | job-627616 | sparse-gateway-7 | infra | South | skipped | 8 | 1108.8 | 4,914,799 | 419,556 | $216.87 | 2044-04-18 |
| 151 | job-361481 | idle-manifest-34 | billing | West | done | 9 | 2538.9 | 4,167,645 | 217,541 | $235.01 | 2044-02-22 |
| 152 | job-995572 | canonical-checkpoint-29 | growth | East | done | 8 | 2141.4 | 1,056,632 | 839,923 | $163.89 | 2044-02-06 |
| 153 | job-506036 | orphaned-transcript-36 | docs | South | queued | 4 | 1796.0 | 3,148,252 | 2,711,250 | $198.65 | 2044-01-07 |
| 154 | job-975834 | partial-cursor-8 | infra | East | queued | 5 | 1559.1 | 1,549,717 | 164,646 | $311.46 | 2044-11-18 |
| 155 | job-775904 | sparse-lease-30 | billing | West | done | 6 | 11.9 | 3,787,107 | 1,190,562 | $375.73 | 2044-05-21 |
| 156 | job-058172 | sparse-cursor-27 | platform | Offshore | queued | 8 | 3195.0 | 199,689 | 126,410 | $25.14 | 2044-06-28 |
| 157 | job-464794 | ephemeral-scheduler-26 | ingest | East | failed | 4 | 3538.1 | 4,944,077 | 314,826 | $250.65 | 2044-04-14 |
| 158 | job-540443 | derived-cursor-14 | growth | Offshore | failed | 6 | 456.6 | 2,416,487 | 765,274 | $133.69 | 2044-12-21 |
| 159 | job-763958 | durable-namespace-13 | infra | Central | running | 4 | 3034.0 | 4,450,890 | 1,972,328 | $382.89 | 2044-01-15 |
| 160 | job-576731 | inbound-digest-1 | docs | North | blocked | 2 | 1985.0 | 1,317,141 | 1,188,569 | $64.97 | 2044-09-11 |
| 161 | job-528447 | inbound-cache-13 | ingest | East | running | 3 | 3410.6 | 2,871,819 | 551,702 | $290.86 | 2044-06-17 |
| 162 | job-996469 | inbound-snapshot-20 | billing | North | running | 5 | 2199.5 | 2,700,226 | 2,014,963 | $80.70 | 2044-07-27 |
| 163 | job-131218 | ephemeral-namespace-8 | growth | East | failed | 9 | 3345.3 | 862,502 | 621,887 | $1.45 | 2044-04-01 |
| 164 | job-405073 | canonical-snapshot-30 | docs | South | queued | 3 | 1117.6 | 1,003,242 | 607,640 | $72.51 | 2044-04-26 |
| 165 | job-064366 | delayed-scheduler-17 | billing | North | done | 3 | 1413.9 | 2,174,653 | 415,556 | $225.41 | 2044-02-05 |
| 166 | job-178622 | canonical-gateway-19 | ingest | Central | failed | 9 | 250.2 | 4,434,823 | 2,351,177 | $264.35 | 2044-07-26 |
| 167 | job-295393 | idle-digest-12 | growth | Central | skipped | 8 | 2518.2 | 1,957,890 | 267,189 | $242.03 | 2044-06-18 |
| 168 | job-099003 | orphaned-ledger-25 | search | East | blocked | 7 | 1788.8 | 1,798,275 | 479,766 | $79.69 | 2044-05-05 |
| 169 | job-148485 | canonical-namespace-24 | search | West | failed | 5 | 1958.3 | 743,228 | 21,841 | $297.23 | 2044-05-05 |
| 170 | job-487133 | immutable-digest-8 | docs | East | queued | 7 | 1631.2 | 2,093,109 | 434,839 | $263.82 | 2044-01-25 |
| 171 | job-364101 | contended-transcript-6 | billing | North | skipped | 2 | 1428.9 | 2,384,986 | 356,768 | $100.68 | 2044-09-02 |
| 172 | job-664503 | durable-replica-36 | billing | West | queued | 7 | 1983.9 | 4,231,380 | 3,282,186 | $290.02 | 2044-05-27 |
| 173 | job-345007 | warm-index-7 | infra | Offshore | failed | 5 | 259.4 | 4,874,472 | 3,232,631 | $128.77 | 2044-07-23 |
| 174 | job-451452 | orphaned-batch-15 | infra | West | failed | 3 | 3294.4 | 3,462,568 | 391,038 | $392.69 | 2044-05-17 |
| 175 | job-555052 | orphaned-replica-9 | platform | East | skipped | 7 | 1096.6 | 2,851,460 | 262,138 | $202.95 | 2044-06-27 |
| 176 | job-787609 | contended-cursor-40 | docs | South | done | 1 | 1625.6 | 686,269 | 360,609 | $227.07 | 2044-11-17 |
| 177 | job-262267 | warm-namespace-26 | billing | Central | queued | 5 | 1485.2 | 4,128,371 | 1,873,367 | $82.49 | 2044-08-13 |
| 178 | job-038598 | partial-queue-25 | infra | Central | queued | 3 | 1014.8 | 206,156 | 11,792 | $31.62 | 2044-08-09 |
| 179 | job-373246 | sparse-transcript-16 | ingest | East | running | 4 | 1941.8 | 2,735,418 | 2,155,386 | $226.91 | 2044-08-15 |
| 180 | job-895815 | inbound-cursor-13 | docs | Offshore | blocked | 9 | 582.5 | 3,510,539 | 692,894 | $85.36 | 2044-10-06 |
| 181 | job-920552 | durable-replica-21 | docs | Central | done | 6 | 2871.4 | 1,834,030 | 1,287,034 | $349.72 | 2044-11-22 |
| 182 | job-619445 | idle-shard-34 | growth | East | queued | 7 | 3161.7 | 3,752,004 | 3,594,518 | $319.30 | 2044-03-08 |
| 183 | job-676285 | nested-queue-23 | infra | East | skipped | 4 | 1474.6 | 1,263,583 | 776,523 | $82.12 | 2044-04-08 |
| 184 | job-199704 | durable-transcript-1 | growth | West | running | 4 | 758.5 | 3,850,853 | 2,350,751 | $168.84 | 2044-10-04 |
| 185 | job-212882 | idle-buffer-16 | growth | West | blocked | 6 | 542.2 | 2,753,424 | 222,802 | $98.61 | 2044-07-16 |
| 186 | job-941249 | contended-replica-20 | infra | West | skipped | 1 | 3243.1 | 1,134,157 | 912,088 | $199.19 | 2044-06-05 |
| 187 | job-630831 | nested-scheduler-37 | docs | Central | running | 3 | 1026.0 | 4,126,437 | 1,215,608 | $116.04 | 2044-05-11 |
| 188 | job-529349 | warm-ledger-22 | platform | Central | blocked | 8 | 31.9 | 815,833 | 253,090 | $130.14 | 2044-09-03 |
| 189 | job-173209 | sparse-replica-19 | search | West | running | 1 | 1307.3 | 2,867,961 | 86,651 | $199.04 | 2044-09-18 |
| 190 | job-225859 | orphaned-transcript-23 | billing | West | done | 8 | 3244.7 | 3,152,220 | 540,076 | $311.92 | 2044-08-28 |
| 191 | job-384667 | orphaned-manifest-7 | billing | South | running | 6 | 2888.7 | 2,377,491 | 683,290 | $319.95 | 2044-03-26 |
| 192 | job-221624 | idle-ledger-37 | platform | North | failed | 8 | 388.1 | 2,426,346 | 2,144,801 | $100.15 | 2044-01-20 |
| 193 | job-710927 | canonical-manifest-23 | docs | North | done | 7 | 3269.2 | 3,650,707 | 934,315 | $376.97 | 2044-01-16 |
| 194 | job-775544 | delayed-checkpoint-39 | platform | North | skipped | 7 | 383.4 | 2,020,068 | 594,755 | $318.19 | 2044-01-21 |
| 195 | job-104610 | delayed-partition-33 | billing | Central | done | 6 | 724.9 | 2,047,339 | 603,238 | $180.88 | 2044-05-01 |
| 196 | job-286775 | partial-quota-6 | billing | East | blocked | 1 | 1678.1 | 1,083,137 | 1,032,538 | $209.10 | 2044-10-13 |
| 197 | job-327536 | delayed-transcript-27 | search | South | done | 8 | 3185.3 | 564,055 | 342,680 | $164.16 | 2044-06-20 |
| 198 | job-706124 | idle-scheduler-14 | platform | South | queued | 9 | 824.5 | 1,986,648 | 196,219 | $143.29 | 2044-10-08 |
| 199 | job-116246 | durable-digest-12 | growth | East | queued | 8 | 2269.1 | 3,513,760 | 2,517,155 | $1.40 | 2044-02-15 |
| 200 | job-092849 | nested-index-14 | docs | West | blocked | 9 | 1829.1 | 1,838,743 | 1,005,842 | $357.26 | 2044-08-07 |
| 201 | job-627293 | contended-envelope-40 | growth | North | running | 8 | 3455.3 | 2,624,941 | 1,911,765 | $289.62 | 2044-11-20 |
| 202 | job-229499 | warm-pipeline-19 | ingest | North | running | 7 | 3283.4 | 549,853 | 184,485 | $325.56 | 2044-05-20 |
| 203 | job-460665 | canonical-lease-11 | docs | Central | blocked | 8 | 1749.2 | 3,090,328 | 843,027 | $98.09 | 2044-06-02 |
| 204 | job-483431 | stale-manifest-36 | billing | East | skipped | 6 | 1375.3 | 4,551,068 | 1,393,523 | $14.10 | 2044-01-08 |
| 205 | job-114981 | derived-registry-10 | growth | South | skipped | 2 | 466.6 | 1,450,147 | 959,271 | $55.91 | 2044-02-03 |
| 206 | job-278351 | delayed-queue-25 | docs | Central | failed | 6 | 109.5 | 3,879,103 | 374,447 | $206.75 | 2044-07-16 |
| 207 | job-675855 | stale-queue-40 | docs | North | queued | 4 | 1909.5 | 814,455 | 263,314 | $159.85 | 2044-08-06 |
| 208 | job-280751 | sparse-digest-40 | platform | West | queued | 9 | 1312.2 | 4,823,465 | 400,009 | $303.60 | 2044-01-12 |
| 209 | job-887152 | warm-checkpoint-24 | ingest | West | running | 7 | 653.1 | 2,356,952 | 1,368,953 | $386.43 | 2044-11-19 |
| 210 | job-494188 | contended-ledger-2 | billing | West | blocked | 5 | 270.8 | 1,329,922 | 1,054,431 | $30.27 | 2044-10-15 |
| 211 | job-323988 | contended-replica-13 | growth | Central | queued | 5 | 1857.7 | 2,212,701 | 967,734 | $159.42 | 2044-07-01 |
| 212 | job-197434 | warm-quota-37 | platform | East | done | 2 | 1743.6 | 2,280,869 | 1,186,551 | $233.77 | 2044-04-27 |
| 213 | job-059098 | inbound-snapshot-9 | docs | North | queued | 8 | 1659.9 | 3,973,477 | 1,345,410 | $287.88 | 2044-11-17 |
| 214 | job-624718 | derived-batch-26 | platform | Central | queued | 6 | 2166.6 | 3,609,113 | 2,112,601 | $319.75 | 2044-07-24 |
| 215 | job-684461 | partial-pipeline-16 | docs | Offshore | queued | 8 | 276.8 | 4,566,010 | 4,194,451 | $75.81 | 2044-08-27 |
| 216 | job-462908 | durable-checkpoint-21 | ingest | South | done | 3 | 743.1 | 3,875,129 | 830,690 | $274.92 | 2044-11-02 |
| 217 | job-969029 | inbound-lease-32 | growth | East | running | 2 | 1478.5 | 3,991,938 | 1,565,595 | $344.86 | 2044-04-18 |
| 218 | job-414522 | orphaned-checkpoint-19 | platform | Offshore | failed | 6 | 2526.3 | 953,471 | 756,860 | $198.05 | 2044-01-22 |
| 219 | job-371173 | delayed-pipeline-34 | growth | Offshore | queued | 4 | 765.7 | 1,707,489 | 976,252 | $95.69 | 2044-01-06 |
| 220 | job-350337 | inbound-index-1 | growth | East | failed | 7 | 1167.2 | 608,568 | 268,079 | $234.41 | 2044-03-07 |
| 221 | job-429882 | canonical-snapshot-2 | docs | North | failed | 4 | 1436.0 | 714,291 | 211,888 | $19.10 | 2044-07-19 |
| 222 | job-103901 | sparse-digest-4 | growth | North | blocked | 7 | 422.2 | 3,349,927 | 1,034,136 | $308.39 | 2044-07-11 |
| 223 | job-929069 | immutable-scheduler-34 | platform | South | queued | 5 | 1504.7 | 1,645,713 | 522,541 | $281.56 | 2044-03-04 |
| 224 | job-024533 | immutable-scheduler-8 | docs | West | failed | 2 | 1822.2 | 1,530,571 | 1,224,979 | $358.09 | 2044-11-01 |
| 225 | job-257456 | immutable-envelope-12 | billing | Offshore | done | 4 | 166.9 | 4,196,219 | 3,716,484 | $371.88 | 2044-08-10 |
| 226 | job-216183 | idle-checkpoint-4 | platform | North | skipped | 8 | 2053.6 | 203,086 | 33,342 | $285.18 | 2044-01-05 |
| 227 | job-230322 | durable-buffer-10 | ingest | Offshore | done | 1 | 2340.8 | 2,650,584 | 39,175 | $78.48 | 2044-08-06 |
| 228 | job-313893 | warm-ledger-28 | billing | North | running | 1 | 2308.5 | 4,007,839 | 2,608,427 | $187.91 | 2044-01-16 |
| 229 | job-911681 | idle-checkpoint-39 | billing | North | queued | 2 | 53.4 | 3,686,707 | 212,031 | $101.43 | 2044-02-14 |
| 230 | job-504030 | partial-checkpoint-32 | docs | East | done | 4 | 889.1 | 700,535 | 518,081 | $251.78 | 2044-04-24 |
| 231 | job-508478 | contended-snapshot-1 | docs | Offshore | failed | 5 | 2053.3 | 1,311,711 | 352,134 | $355.36 | 2044-03-27 |
| 232 | job-908409 | derived-manifest-7 | docs | East | done | 4 | 833.5 | 3,774,015 | 2,681,312 | $156.16 | 2044-02-28 |
| 233 | job-252521 | idle-envelope-20 | growth | West | skipped | 5 | 3293.4 | 286,543 | 38,104 | $117.79 | 2044-08-04 |
| 234 | job-331702 | delayed-lease-5 | platform | Offshore | queued | 1 | 1791.7 | 712,497 | 96,223 | $308.07 | 2044-10-02 |
| 235 | job-995702 | durable-snapshot-14 | platform | South | running | 1 | 37.5 | 3,341,886 | 2,446,421 | $96.39 | 2044-08-27 |
| 236 | job-768823 | contended-quota-39 | ingest | South | done | 8 | 1780.9 | 42,058 | 40,265 | $66.05 | 2044-01-03 |
| 237 | job-482627 | immutable-shard-34 | ingest | Central | failed | 9 | 3439.7 | 365,064 | 64,193 | $377.87 | 2044-05-23 |
| 238 | job-698454 | canonical-gateway-11 | platform | Central | failed | 4 | 2476.3 | 2,144,006 | 886,766 | $342.31 | 2044-02-25 |
| 239 | job-288998 | delayed-partition-23 | infra | Offshore | blocked | 8 | 923.0 | 710,151 | 151,549 | $14.26 | 2044-02-08 |
| 240 | job-296598 | warm-registry-40 | billing | North | skipped | 9 | 583.0 | 2,896,582 | 2,466,594 | $374.81 | 2044-03-01 |
| 241 | job-469030 | delayed-cursor-24 | billing | West | skipped | 3 | 559.6 | 608,830 | 287,767 | $1.87 | 2044-04-16 |
| 242 | job-991791 | inbound-namespace-18 | growth | Offshore | failed | 9 | 674.1 | 2,705,301 | 53,725 | $116.49 | 2044-06-03 |
| 243 | job-507389 | contended-buffer-6 | docs | North | failed | 9 | 2693.5 | 1,941,992 | 797,011 | $317.15 | 2044-07-18 |
| 244 | job-253866 | warm-batch-14 | infra | South | blocked | 2 | 1597.6 | 2,332,135 | 1,706,210 | $33.97 | 2044-12-06 |
| 245 | job-512199 | stale-envelope-1 | platform | South | blocked | 7 | 2124.3 | 521,331 | 260,595 | $200.14 | 2044-08-07 |
| 246 | job-993643 | inbound-checkpoint-16 | platform | Central | failed | 8 | 2413.8 | 3,743,787 | 1,747,495 | $16.79 | 2044-02-05 |
| 247 | job-460146 | stale-index-7 | platform | East | running | 4 | 2210.7 | 2,312,954 | 1,854,163 | $184.59 | 2044-08-16 |
| 248 | job-495690 | idle-shard-30 | platform | Offshore | failed | 5 | 1818.3 | 1,219,587 | 28,828 | $166.68 | 2044-06-17 |
| 249 | job-911466 | nested-shard-1 | growth | Central | skipped | 1 | 46.5 | 1,398,255 | 656,520 | $18.76 | 2044-04-05 |
| 250 | job-164256 | nested-shard-18 | growth | North | skipped | 4 | 269.3 | 1,125,540 | 89,307 | $183.52 | 2044-07-28 |
| 251 | job-245655 | stale-scheduler-8 | docs | West | done | 5 | 2100.2 | 1,006,464 | 130,323 | $321.97 | 2044-12-08 |
| 252 | job-305618 | durable-scheduler-11 | ingest | East | running | 4 | 2926.5 | 214,371 | 2,127 | $260.25 | 2044-11-28 |
| 253 | job-594218 | stale-queue-27 | platform | Offshore | failed | 5 | 1729.0 | 3,601,617 | 2,511,825 | $34.43 | 2044-05-09 |
| 254 | job-161458 | contended-partition-17 | billing | Offshore | running | 1 | 1352.5 | 3,166,953 | 1,792,006 | $104.28 | 2044-03-11 |
| 255 | job-768440 | inbound-queue-39 | ingest | Offshore | skipped | 7 | 1053.0 | 4,380,077 | 513,639 | $162.53 | 2044-03-15 |
| 256 | job-633352 | partial-index-33 | billing | Offshore | running | 2 | 3431.2 | 2,537,077 | 2,008,571 | $283.15 | 2044-08-20 |
| 257 | job-483345 | stale-lease-12 | billing | South | blocked | 1 | 1148.3 | 495,163 | 329,865 | $106.34 | 2044-12-13 |
| 258 | job-002536 | contended-queue-33 | docs | Offshore | skipped | 1 | 1486.1 | 3,034,770 | 322,987 | $155.43 | 2044-07-28 |
| 259 | job-912047 | contended-cursor-17 | docs | Offshore | queued | 4 | 914.1 | 1,382,474 | 927,694 | $113.70 | 2044-03-03 |
| 260 | job-423826 | partial-index-22 | growth | West | skipped | 6 | 916.3 | 2,632,685 | 1,258,015 | $9.57 | 2044-04-13 |
| 261 | job-019362 | durable-queue-40 | platform | North | skipped | 6 | 1484.1 | 4,242,933 | 3,570,685 | $275.63 | 2044-06-04 |
| 262 | job-708966 | stale-cache-21 | billing | Central | failed | 4 | 2350.6 | 2,673,203 | 2,441,181 | $187.16 | 2044-05-08 |
| 263 | job-766234 | ephemeral-pipeline-24 | billing | East | queued | 9 | 2211.0 | 4,423,474 | 1,389,468 | $239.98 | 2044-05-22 |
| 264 | job-259676 | ephemeral-snapshot-6 | growth | Central | done | 5 | 148.2 | 1,595,895 | 1,524,267 | $39.54 | 2044-11-17 |
| 265 | job-924821 | delayed-index-36 | search | East | skipped | 5 | 2768.9 | 2,550,530 | 2,235,615 | $215.54 | 2044-01-02 |
| 266 | job-691000 | inbound-digest-9 | ingest | South | blocked | 8 | 2372.1 | 2,633,573 | 2,136,741 | $0.51 | 2044-04-07 |
| 267 | job-032444 | derived-lease-14 | ingest | West | queued | 7 | 2126.2 | 1,373,004 | 912,761 | $319.32 | 2044-06-23 |
| 268 | job-340990 | partial-transcript-39 | platform | Central | queued | 5 | 3495.9 | 3,220,658 | 1,577,410 | $50.73 | 2044-01-26 |
| 269 | job-462128 | inbound-snapshot-12 | growth | Central | queued | 2 | 2802.4 | 2,290,002 | 1,238,858 | $251.01 | 2044-03-03 |
| 270 | job-240487 | ephemeral-digest-14 | search | Offshore | blocked | 5 | 3404.3 | 1,734,492 | 222,398 | $265.67 | 2044-01-06 |
| 271 | job-701784 | ephemeral-transcript-14 | search | East | failed | 5 | 2339.3 | 312,309 | 54,022 | $163.30 | 2044-02-17 |
| 272 | job-234962 | delayed-cache-18 | platform | North | failed | 5 | 737.9 | 3,134,487 | 2,885,676 | $361.97 | 2044-02-26 |
| 273 | job-759610 | ephemeral-transcript-12 | infra | West | skipped | 7 | 2882.7 | 3,753,667 | 1,150,649 | $185.98 | 2044-05-19 |
| 274 | job-345983 | idle-lease-22 | growth | South | done | 1 | 218.3 | 1,620,720 | 944,895 | $216.44 | 2044-12-10 |
| 275 | job-647755 | warm-index-10 | docs | West | running | 3 | 1888.0 | 3,962,178 | 2,319,088 | $324.27 | 2044-07-08 |
| 276 | job-753983 | derived-ledger-6 | docs | East | blocked | 5 | 3052.8 | 3,075,948 | 3,057,625 | $219.26 | 2044-07-26 |
| 277 | job-361891 | stale-scheduler-21 | growth | Offshore | running | 9 | 3389.9 | 2,619,081 | 542 | $328.77 | 2044-12-21 |
| 278 | job-554535 | durable-namespace-18 | platform | Offshore | skipped | 3 | 1686.2 | 4,260,182 | 4,086,357 | $88.71 | 2044-01-12 |
| 279 | job-127892 | contended-pipeline-6 | infra | South | queued | 7 | 2537.9 | 3,112,887 | 2,997,258 | $164.71 | 2044-11-21 |
| 280 | job-649501 | canonical-replica-37 | billing | East | done | 5 | 1845.7 | 2,446,202 | 1,975,743 | $157.95 | 2044-04-13 |
| 281 | job-172828 | durable-namespace-26 | search | East | skipped | 7 | 729.4 | 3,698,769 | 1,261,698 | $13.76 | 2044-02-06 |
| 282 | job-258380 | orphaned-lease-3 | growth | West | running | 6 | 1865.3 | 3,422,985 | 2,908,532 | $365.63 | 2044-03-12 |
| 283 | job-501863 | warm-namespace-8 | infra | Offshore | blocked | 1 | 3574.7 | 4,179,548 | 1,458,682 | $121.73 | 2044-01-25 |
| 284 | job-707453 | inbound-cursor-16 | billing | Offshore | blocked | 7 | 2377.3 | 2,670,200 | 429,249 | $316.62 | 2044-11-07 |
| 285 | job-584121 | sparse-digest-13 | docs | South | queued | 2 | 624.3 | 3,898,351 | 2,594,267 | $189.17 | 2044-02-10 |
| 286 | job-819467 | partial-queue-16 | search | East | running | 8 | 546.8 | 728,111 | 64,776 | $34.90 | 2044-10-08 |
| 287 | job-570536 | contended-transcript-32 | growth | Offshore | done | 5 | 2038.5 | 1,684,931 | 564,882 | $52.83 | 2044-04-20 |
| 288 | job-736438 | orphaned-buffer-26 | search | North | failed | 3 | 425.1 | 295,957 | 140,594 | $63.00 | 2044-01-24 |
| 289 | job-167524 | orphaned-registry-36 | docs | North | queued | 7 | 3113.3 | 311,749 | 133,029 | $30.73 | 2044-11-06 |
| 290 | job-713906 | canonical-namespace-10 | platform | East | running | 7 | 1835.5 | 4,122,495 | 2,566,296 | $298.60 | 2044-12-15 |
| 291 | job-358656 | stale-index-20 | search | North | failed | 7 | 3416.6 | 2,135,948 | 644,534 | $109.14 | 2044-11-15 |
| 292 | job-465592 | idle-scheduler-2 | infra | East | failed | 1 | 1695.8 | 4,160,840 | 3,312,529 | $2.36 | 2044-08-17 |
| 293 | job-984015 | orphaned-pipeline-2 | platform | West | queued | 3 | 2370.3 | 4,413,847 | 658,770 | $98.69 | 2044-06-10 |
| 294 | job-631678 | stale-cursor-38 | infra | East | done | 1 | 1294.4 | 3,925,252 | 611,168 | $390.38 | 2044-10-03 |
| 295 | job-146709 | durable-registry-36 | platform | East | blocked | 6 | 1562.9 | 2,065,634 | 1,321,678 | $385.58 | 2044-05-14 |
| 296 | job-798331 | derived-queue-27 | infra | Central | failed | 4 | 3244.4 | 3,704,330 | 859,105 | $308.76 | 2044-03-07 |
| 297 | job-174614 | inbound-pipeline-37 | growth | East | blocked | 7 | 807.9 | 3,040,635 | 2,659,561 | $341.68 | 2044-01-14 |
| 298 | job-677348 | partial-replica-16 | ingest | West | failed | 3 | 1726.2 | 4,194,548 | 2,476,303 | $191.86 | 2044-04-08 |
| 299 | job-929634 | warm-digest-35 | docs | West | blocked | 1 | 385.1 | 4,372,605 | 45,255 | $307.71 | 2044-01-11 |
| 300 | job-011868 | contended-scheduler-17 | platform | North | running | 9 | 207.6 | 588,761 | 2,742 | $182.21 | 2044-10-13 |
| 301 | job-047101 | idle-snapshot-25 | ingest | Offshore | skipped | 3 | 133.5 | 2,613,057 | 1,273,187 | $314.76 | 2044-12-15 |
| 302 | job-489143 | contended-index-27 | platform | North | failed | 7 | 2860.8 | 736,670 | 40,711 | $300.47 | 2044-05-14 |
| 303 | job-882928 | stale-partition-22 | platform | East | queued | 8 | 2763.2 | 3,190,535 | 1,885,454 | $305.52 | 2044-05-02 |
| 304 | job-949969 | idle-replica-36 | docs | Central | done | 8 | 349.4 | 1,215,469 | 1,006,260 | $31.17 | 2044-02-09 |
| 305 | job-702613 | ephemeral-cache-35 | docs | North | blocked | 8 | 1349.6 | 741,470 | 9,882 | $366.79 | 2044-06-26 |
| 306 | job-574506 | inbound-registry-38 | platform | South | skipped | 2 | 1094.1 | 1,615,220 | 565,620 | $5.83 | 2044-11-14 |
| 307 | job-662647 | ephemeral-buffer-16 | ingest | East | skipped | 4 | 2750.0 | 4,878,760 | 3,142,314 | $210.19 | 2044-10-01 |
| 308 | job-652213 | immutable-registry-37 | billing | Central | skipped | 4 | 893.2 | 264,779 | 17,790 | $221.29 | 2044-05-17 |
| 309 | job-624124 | ephemeral-manifest-26 | growth | South | running | 1 | 1028.2 | 2,403,123 | 1,098,781 | $220.46 | 2044-08-27 |
| 310 | job-687657 | contended-envelope-9 | platform | Offshore | done | 3 | 2741.7 | 2,810,601 | 113,892 | $246.74 | 2044-07-18 |
| 311 | job-982643 | contended-gateway-19 | docs | East | queued | 8 | 322.0 | 341,243 | 297,337 | $356.41 | 2044-09-02 |
| 312 | job-419619 | warm-envelope-29 | search | East | running | 8 | 2252.2 | 304,939 | 90,350 | $148.26 | 2044-03-18 |
| 313 | job-966710 | partial-registry-3 | ingest | West | skipped | 3 | 1336.0 | 958,129 | 34,174 | $146.21 | 2044-09-07 |
| 314 | job-535030 | partial-shard-6 | docs | East | blocked | 5 | 574.2 | 1,700,587 | 180,170 | $105.09 | 2044-02-25 |
| 315 | job-996393 | inbound-queue-31 | search | North | skipped | 8 | 1059.2 | 3,320,333 | 729,443 | $314.31 | 2044-12-15 |
| 316 | job-781161 | ephemeral-cursor-28 | ingest | South | blocked | 8 | 2372.8 | 2,834,812 | 666,518 | $3.00 | 2044-06-16 |
| 317 | job-065408 | ephemeral-scheduler-32 | infra | East | running | 1 | 1130.6 | 3,099,032 | 801,822 | $384.87 | 2044-11-08 |
| 318 | job-675965 | canonical-index-38 | platform | North | blocked | 5 | 1291.9 | 4,585,383 | 3,221,739 | $47.66 | 2044-08-19 |
| 319 | job-887068 | warm-checkpoint-3 | billing | West | queued | 1 | 3236.5 | 2,660,901 | 1,570,948 | $34.96 | 2044-09-21 |
| 320 | job-128598 | ephemeral-shard-17 | growth | Central | failed | 7 | 1045.0 | 1,515,949 | 1,373,140 | $191.16 | 2044-03-18 |
| 321 | job-845041 | orphaned-snapshot-30 | infra | North | done | 3 | 3469.3 | 1,437,117 | 656,520 | $255.86 | 2044-08-13 |
| 322 | job-085579 | partial-queue-22 | platform | Offshore | failed | 8 | 3242.0 | 3,924,818 | 3,441,482 | $171.60 | 2044-10-09 |
| 323 | job-856590 | durable-queue-39 | billing | East | running | 5 | 2593.4 | 417,023 | 344,080 | $88.55 | 2044-05-03 |
| 324 | job-508981 | immutable-transcript-1 | platform | South | blocked | 2 | 1217.0 | 2,928,760 | 428,301 | $237.80 | 2044-05-11 |
| 325 | job-405551 | inbound-snapshot-31 | search | East | blocked | 2 | 999.2 | 2,290,546 | 348,468 | $305.79 | 2044-08-19 |
| 326 | job-816814 | ephemeral-cursor-10 | docs | South | skipped | 6 | 264.7 | 910,804 | 393,926 | $363.31 | 2044-07-22 |
| 327 | job-543879 | canonical-cache-21 | infra | East | failed | 9 | 692.6 | 3,672,957 | 1,501,878 | $393.27 | 2044-05-16 |
| 328 | job-298629 | derived-scheduler-28 | docs | East | skipped | 9 | 2118.7 | 3,716,319 | 1,670,815 | $81.54 | 2044-01-13 |
| 329 | job-628842 | ephemeral-ledger-4 | growth | North | blocked | 6 | 691.5 | 359,678 | 246,616 | $305.35 | 2044-11-03 |
| 330 | job-490753 | inbound-namespace-26 | platform | East | blocked | 6 | 154.9 | 512,522 | 24,687 | $280.82 | 2044-09-24 |
| 331 | job-044253 | derived-index-2 | search | Offshore | failed | 1 | 2842.3 | 3,462,853 | 546,353 | $59.89 | 2044-02-23 |
| 332 | job-542451 | ephemeral-digest-17 | infra | North | queued | 1 | 2131.3 | 372,237 | 204,993 | $33.09 | 2044-11-19 |
| 333 | job-022877 | partial-partition-28 | docs | North | failed | 1 | 1828.5 | 1,551,061 | 580,440 | $282.69 | 2044-12-23 |
| 334 | job-590906 | idle-cache-39 | infra | Central | running | 6 | 276.8 | 2,493,108 | 2,358,641 | $364.49 | 2044-09-24 |
| 335 | job-887280 | immutable-scheduler-17 | billing | West | skipped | 3 | 956.6 | 3,328,351 | 494,982 | $120.42 | 2044-08-16 |
| 336 | job-861511 | derived-queue-14 | infra | West | failed | 9 | 1318.5 | 1,689,965 | 676,379 | $44.73 | 2044-03-20 |
| 337 | job-466326 | nested-cursor-24 | search | South | queued | 8 | 2528.8 | 2,062,160 | 80,658 | $236.23 | 2044-06-08 |
| 338 | job-140181 | durable-buffer-40 | docs | West | failed | 7 | 515.2 | 301,300 | 110,613 | $25.48 | 2044-07-22 |
| 339 | job-980020 | derived-buffer-20 | platform | East | blocked | 2 | 62.0 | 1,945,718 | 826,589 | $2.60 | 2044-01-17 |
| 340 | job-816407 | partial-partition-33 | growth | Offshore | running | 4 | 1581.3 | 3,813,062 | 369,110 | $139.38 | 2044-06-14 |
| 341 | job-409335 | ephemeral-shard-16 | ingest | West | blocked | 4 | 46.8 | 4,612,649 | 99,386 | $222.96 | 2044-11-24 |
| 342 | job-035329 | partial-cursor-1 | docs | Central | queued | 8 | 1143.0 | 3,985,488 | 2,974,947 | $275.65 | 2044-09-13 |
| 343 | job-845603 | contended-buffer-10 | growth | Offshore | blocked | 9 | 983.3 | 900,624 | 823,226 | $270.87 | 2044-04-18 |
| 344 | job-224333 | durable-queue-8 | billing | South | blocked | 5 | 1841.4 | 1,030,347 | 156,504 | $299.08 | 2044-04-02 |
| 345 | job-218985 | durable-index-32 | search | South | done | 8 | 1114.0 | 4,279,952 | 3,157,201 | $105.13 | 2044-12-20 |
| 346 | job-715367 | sparse-cursor-21 | search | Central | done | 4 | 460.6 | 4,889,974 | 55,222 | $89.84 | 2044-03-01 |
| 347 | job-517988 | orphaned-snapshot-25 | billing | North | blocked | 9 | 2259.0 | 1,209,010 | 469,116 | $272.42 | 2044-10-08 |
| 348 | job-059124 | immutable-gateway-30 | billing | Offshore | blocked | 3 | 1260.0 | 2,300,476 | 1,090,119 | $189.83 | 2044-06-09 |
| 349 | job-356614 | durable-cache-26 | billing | Offshore | done | 3 | 2979.5 | 4,878,199 | 2,575,211 | $288.28 | 2044-01-09 |
| 350 | job-983608 | ephemeral-buffer-31 | billing | South | failed | 8 | 602.0 | 861,785 | 597,550 | $323.76 | 2044-12-05 |
| 351 | job-122744 | sparse-digest-8 | billing | Central | queued | 8 | 2328.1 | 4,371,953 | 3,201,544 | $201.65 | 2044-02-13 |
| 352 | job-374579 | stale-transcript-17 | billing | Offshore | done | 6 | 500.0 | 3,152,850 | 1,384,880 | $277.80 | 2044-11-10 |
| 353 | job-216917 | idle-gateway-27 | infra | West | blocked | 5 | 1266.4 | 4,358,517 | 2,234,853 | $5.45 | 2044-08-28 |
| 354 | job-542106 | delayed-shard-33 | ingest | East | failed | 2 | 1155.4 | 2,968,377 | 1,951,836 | $119.56 | 2044-02-01 |
| 355 | job-878610 | ephemeral-gateway-37 | ingest | North | failed | 6 | 1258.0 | 1,340,980 | 846,650 | $338.69 | 2044-09-12 |
| 356 | job-169228 | partial-transcript-31 | ingest | Central | done | 6 | 1562.6 | 4,551,250 | 1,323,533 | $289.77 | 2044-01-11 |
| 357 | job-819565 | derived-pipeline-23 | growth | Central | queued | 3 | 2719.2 | 4,290,506 | 2,471,707 | $113.76 | 2044-02-25 |
| 358 | job-039568 | partial-index-35 | ingest | North | running | 3 | 1038.8 | 2,213,270 | 550,022 | $87.98 | 2044-05-19 |
| 359 | job-729318 | nested-registry-6 | platform | West | failed | 5 | 2559.6 | 1,947,196 | 1,496,711 | $29.55 | 2044-12-19 |
| 360 | job-596649 | canonical-checkpoint-11 | growth | South | failed | 8 | 1061.8 | 2,616,058 | 683,056 | $259.52 | 2044-12-19 |
| 361 | job-829110 | nested-buffer-33 | infra | South | failed | 5 | 3057.8 | 2,753,323 | 1,001,931 | $119.55 | 2044-02-08 |
| 362 | job-614524 | ephemeral-buffer-2 | growth | North | done | 8 | 41.3 | 4,588,711 | 4,163,893 | $364.37 | 2044-12-05 |
| 363 | job-856949 | orphaned-transcript-40 | billing | East | queued | 7 | 137.8 | 1,839,767 | 1,014,543 | $294.00 | 2044-02-04 |
| 364 | job-572509 | derived-cursor-7 | search | Central | blocked | 6 | 704.6 | 2,659,589 | 818,870 | $1.96 | 2044-03-23 |
| 365 | job-466110 | warm-gateway-29 | search | West | done | 4 | 3483.2 | 2,189,809 | 989,733 | $194.82 | 2044-07-17 |
| 366 | job-044865 | stale-pipeline-11 | docs | West | skipped | 3 | 280.5 | 364,693 | 256,460 | $36.45 | 2044-03-24 |
| 367 | job-572040 | stale-digest-26 | infra | North | running | 7 | 3109.0 | 1,283,191 | 13,782 | $375.59 | 2044-08-15 |
| 368 | job-653682 | orphaned-partition-33 | platform | South | failed | 1 | 67.1 | 2,709,250 | 2,316,976 | $154.23 | 2044-10-12 |
| 369 | job-265998 | derived-index-37 | ingest | Central | queued | 1 | 1479.6 | 8,150 | 5,321 | $280.65 | 2044-03-02 |
| 370 | job-011101 | contended-registry-37 | growth | West | done | 6 | 2622.4 | 4,092,859 | 50,546 | $96.14 | 2044-01-04 |
| 371 | job-192871 | partial-manifest-18 | docs | East | done | 1 | 767.3 | 1,846,753 | 1,215,451 | $22.61 | 2044-11-15 |
| 372 | job-091749 | ephemeral-partition-2 | growth | North | skipped | 4 | 2977.0 | 1,851,877 | 1,551,961 | $366.18 | 2044-08-20 |
| 373 | job-408872 | stale-partition-19 | platform | Offshore | done | 3 | 2768.5 | 1,227,817 | 1,176,956 | $187.58 | 2044-10-23 |
| 374 | job-185863 | sparse-checkpoint-23 | infra | East | done | 7 | 599.2 | 4,244,639 | 4,006,523 | $226.71 | 2044-10-26 |
| 375 | job-284128 | warm-replica-14 | growth | Central | blocked | 7 | 3505.9 | 1,130,249 | 20,624 | $297.20 | 2044-11-18 |
| 376 | job-250203 | contended-namespace-9 | ingest | Central | blocked | 6 | 3162.5 | 4,472,736 | 1,981,396 | $69.82 | 2044-09-16 |
| 377 | job-302840 | stale-cursor-28 | ingest | South | blocked | 7 | 767.2 | 1,788,782 | 1,395,091 | $303.40 | 2044-01-22 |
| 378 | job-072390 | immutable-gateway-38 | search | West | skipped | 9 | 1882.2 | 4,933,895 | 4,683,336 | $294.21 | 2044-02-12 |
| 379 | job-174069 | delayed-cache-25 | growth | West | failed | 8 | 2295.6 | 969,296 | 701,537 | $215.44 | 2044-03-08 |
| 380 | job-516765 | partial-transcript-24 | growth | West | running | 7 | 3517.6 | 1,004,575 | 1,295 | $114.18 | 2044-07-23 |
| 381 | job-253369 | sparse-ledger-36 | docs | North | queued | 1 | 508.3 | 428,585 | 104,576 | $366.59 | 2044-08-06 |
| 382 | job-984444 | idle-digest-15 | ingest | South | failed | 2 | 1868.1 | 1,045,018 | 840,053 | $23.57 | 2044-04-08 |
| 383 | job-441601 | durable-cache-26 | platform | Central | queued | 8 | 1504.0 | 1,436,996 | 288,232 | $396.64 | 2044-02-28 |
| 384 | job-044521 | derived-batch-13 | platform | South | skipped | 2 | 631.8 | 3,783,866 | 2,148,558 | $110.39 | 2044-12-07 |
| 385 | job-620790 | contended-namespace-25 | infra | South | queued | 3 | 1834.8 | 1,147,428 | 1,839 | $289.77 | 2044-10-15 |
| 386 | job-922290 | sparse-pipeline-18 | ingest | North | skipped | 5 | 146.3 | 4,899,387 | 3,549,486 | $32.20 | 2044-07-26 |
| 387 | job-975026 | ephemeral-batch-14 | search | South | failed | 8 | 15.9 | 1,470,751 | 1,164,783 | $87.69 | 2044-09-17 |
| 388 | job-005074 | durable-quota-40 | docs | Central | running | 5 | 3281.7 | 1,521,045 | 701,120 | $287.62 | 2044-07-25 |
| 389 | job-406298 | contended-namespace-14 | growth | Central | done | 2 | 1020.9 | 4,510,119 | 1,976,458 | $145.65 | 2044-04-24 |
| 390 | job-417104 | canonical-buffer-11 | search | South | running | 7 | 2425.1 | 4,312,871 | 3,023,766 | $61.33 | 2044-06-07 |
| 391 | job-398355 | derived-ledger-26 | growth | East | blocked | 1 | 951.0 | 3,463,550 | 2,277,761 | $185.94 | 2044-03-23 |
| 392 | job-378301 | warm-scheduler-1 | search | East | failed | 1 | 1020.1 | 4,104,925 | 3,717,742 | $350.54 | 2044-09-24 |
| 393 | job-303693 | durable-pipeline-17 | docs | West | failed | 1 | 653.0 | 3,272,609 | 1,629,436 | $176.14 | 2044-01-03 |
| 394 | job-924521 | durable-buffer-9 | growth | Offshore | blocked | 5 | 3025.5 | 791,721 | 10,515 | $271.05 | 2044-07-03 |
| 395 | job-969825 | inbound-namespace-28 | billing | South | queued | 9 | 2395.5 | 2,880,510 | 2,274,632 | $336.45 | 2044-11-13 |
| 396 | job-835661 | delayed-checkpoint-25 | ingest | South | running | 8 | 1968.7 | 3,216,713 | 2,427,277 | $197.48 | 2044-07-26 |
| 397 | job-666181 | partial-transcript-33 | docs | East | failed | 7 | 2133.7 | 4,848,466 | 1,315,211 | $317.01 | 2044-03-12 |
| 398 | job-055309 | derived-manifest-34 | search | North | running | 1 | 2489.9 | 2,117,953 | 1,470,294 | $203.18 | 2044-07-23 |
| 399 | job-303441 | nested-buffer-28 | ingest | North | running | 9 | 3281.0 | 2,519,868 | 2,430,563 | $358.78 | 2044-09-26 |
| 400 | job-833215 | orphaned-index-27 | infra | South | queued | 2 | 3518.8 | 2,856,390 | 2,581,512 | $359.06 | 2044-09-26 |
| 401 | job-188879 | derived-digest-34 | docs | East | blocked | 8 | 300.1 | 3,099,517 | 2,449,730 | $243.07 | 2044-06-21 |
| 402 | job-529795 | ephemeral-digest-35 | docs | Offshore | failed | 5 | 1769.5 | 1,312,026 | 1,081,008 | $184.00 | 2044-07-24 |
| 403 | job-980141 | derived-cursor-18 | infra | South | failed | 2 | 3309.8 | 4,504,585 | 1,062,845 | $323.26 | 2044-05-13 |
| 404 | job-589769 | durable-registry-21 | ingest | East | running | 3 | 1188.1 | 4,624,209 | 932,424 | $244.34 | 2044-07-21 |
| 405 | job-504136 | partial-cursor-12 | growth | Offshore | skipped | 6 | 1537.3 | 1,776,665 | 1,466,810 | $188.82 | 2044-04-26 |
| 406 | job-370748 | derived-scheduler-11 | ingest | East | skipped | 3 | 1338.6 | 982,707 | 452,858 | $349.04 | 2044-12-10 |
| 407 | job-649119 | stale-scheduler-20 | growth | East | done | 3 | 571.0 | 4,708,598 | 2,249,650 | $139.61 | 2044-06-06 |
| 408 | job-734788 | warm-partition-21 | search | South | failed | 5 | 1732.8 | 4,991,780 | 3,085,947 | $322.37 | 2044-03-04 |
| 409 | job-072137 | idle-gateway-16 | billing | Central | queued | 7 | 1793.4 | 707,349 | 186,430 | $93.44 | 2044-02-22 |
| 410 | job-790405 | immutable-replica-10 | docs | Offshore | running | 5 | 3243.3 | 4,561,129 | 2,807,445 | $289.05 | 2044-03-23 |
| 411 | job-494274 | canonical-quota-18 | docs | South | running | 6 | 1186.6 | 686,345 | 639,794 | $349.01 | 2044-04-04 |
| 412 | job-222905 | ephemeral-registry-2 | growth | North | blocked | 7 | 1004.8 | 1,429,650 | 1,054,631 | $58.76 | 2044-01-03 |
| 413 | job-009104 | ephemeral-snapshot-16 | growth | Central | running | 7 | 2098.9 | 1,389,892 | 409,112 | $216.28 | 2044-10-05 |
| 414 | job-405749 | stale-queue-9 | ingest | East | failed | 5 | 3130.8 | 177,961 | 170,454 | $33.52 | 2044-01-06 |
| 415 | job-528163 | durable-snapshot-30 | platform | Central | blocked | 1 | 1019.4 | 376,665 | 353,398 | $379.03 | 2044-05-26 |
| 416 | job-932734 | delayed-replica-12 | platform | West | running | 4 | 3527.9 | 1,717,329 | 1,637,326 | $346.34 | 2044-08-16 |
| 417 | job-075197 | ephemeral-ledger-1 | search | East | queued | 3 | 876.5 | 4,392,357 | 3,652,684 | $87.91 | 2044-01-25 |
| 418 | job-688451 | inbound-quota-26 | platform | South | done | 5 | 1300.2 | 4,899,886 | 3,258,080 | $136.62 | 2044-11-13 |
| 419 | job-760394 | contended-pipeline-24 | ingest | West | skipped | 6 | 1536.9 | 4,497,046 | 2,991,964 | $2.87 | 2044-05-28 |
| 420 | job-734666 | contended-ledger-13 | docs | East | blocked | 1 | 3228.5 | 492,768 | 382,191 | $109.31 | 2044-11-16 |
| 421 | job-479489 | delayed-ledger-1 | docs | North | done | 7 | 1328.6 | 931,115 | 385,770 | $83.47 | 2044-08-19 |
| 422 | job-854812 | orphaned-snapshot-34 | billing | East | blocked | 8 | 2649.9 | 648,441 | 14,784 | $193.50 | 2044-06-20 |
| 423 | job-863014 | stale-gateway-3 | growth | Central | done | 7 | 593.7 | 1,692,146 | 443,621 | $323.22 | 2044-11-28 |
| 424 | job-315216 | inbound-queue-12 | search | North | skipped | 7 | 156.4 | 4,290,409 | 1,690,431 | $155.70 | 2044-09-17 |
| 425 | job-058510 | ephemeral-transcript-35 | infra | South | done | 6 | 3184.5 | 1,564,876 | 1,012,908 | $61.09 | 2044-08-25 |
| 426 | job-057906 | idle-queue-16 | billing | Offshore | queued | 4 | 86.4 | 2,877,979 | 2,185,793 | $109.59 | 2044-04-15 |
| 427 | job-805766 | ephemeral-partition-1 | platform | West | blocked | 2 | 1925.6 | 3,713,029 | 553,464 | $71.27 | 2044-08-06 |
| 428 | job-725449 | immutable-cache-24 | infra | South | done | 8 | 1953.8 | 1,213,787 | 912,497 | $284.01 | 2044-02-02 |
| 429 | job-764963 | derived-envelope-5 | platform | East | queued | 6 | 2587.9 | 3,502,866 | 3,161,785 | $138.46 | 2044-11-14 |
| 430 | job-082501 | delayed-registry-15 | search | South | queued | 2 | 3224.8 | 3,562,618 | 2,941,553 | $222.83 | 2044-11-19 |
| 431 | job-662660 | sparse-replica-15 | infra | South | blocked | 7 | 496.4 | 659,461 | 260,251 | $39.35 | 2044-03-23 |
| 432 | job-926823 | idle-queue-16 | platform | East | blocked | 6 | 1634.8 | 4,389,774 | 4,379,978 | $182.71 | 2044-10-23 |
| 433 | job-255271 | nested-queue-31 | ingest | North | queued | 6 | 2665.3 | 3,017,321 | 1,482,382 | $209.09 | 2044-08-17 |
| 434 | job-593796 | immutable-cache-31 | ingest | East | running | 6 | 630.8 | 1,131,243 | 740,125 | $331.93 | 2044-06-04 |
| 435 | job-544294 | idle-checkpoint-7 | docs | West | running | 7 | 2053.5 | 505,531 | 98,362 | $216.98 | 2044-12-21 |
| 436 | job-119733 | ephemeral-queue-31 | ingest | Central | blocked | 3 | 1777.3 | 4,247,738 | 2,556,152 | $267.78 | 2044-07-11 |
| 437 | job-343547 | derived-batch-34 | billing | West | done | 9 | 2930.4 | 2,152,475 | 889,586 | $74.84 | 2044-05-27 |
| 438 | job-430782 | ephemeral-transcript-23 | search | South | failed | 5 | 2923.9 | 3,922,890 | 20,391 | $168.81 | 2044-05-23 |
| 439 | job-703887 | ephemeral-pipeline-39 | platform | Offshore | blocked | 1 | 2103.3 | 4,375,803 | 2,410,795 | $378.14 | 2044-07-05 |
| 440 | job-311654 | ephemeral-queue-4 | docs | Central | done | 8 | 3136.6 | 1,397,325 | 1,067,988 | $196.10 | 2044-02-27 |
| 441 | job-597633 | inbound-quota-7 | growth | North | blocked | 6 | 1429.5 | 3,908,184 | 1,064,786 | $345.67 | 2044-03-15 |
| 442 | job-859300 | stale-pipeline-5 | platform | Offshore | skipped | 3 | 1030.3 | 3,684,375 | 3,613,300 | $91.57 | 2044-10-19 |
| 443 | job-369018 | durable-transcript-28 | ingest | Central | failed | 4 | 1692.1 | 2,158,781 | 1,422,614 | $252.22 | 2044-11-23 |
| 444 | job-349545 | durable-index-23 | search | South | done | 2 | 3327.3 | 3,606,641 | 2,603,157 | $240.32 | 2044-03-18 |
| 445 | job-814213 | immutable-lease-25 | billing | West | blocked | 6 | 1861.2 | 3,655,576 | 2,730,675 | $5.27 | 2044-09-06 |
| 446 | job-470799 | ephemeral-queue-18 | search | Central | running | 5 | 1006.8 | 4,543,856 | 262,067 | $195.51 | 2044-09-21 |
| 447 | job-752249 | nested-cache-10 | billing | East | queued | 2 | 1131.7 | 1,179,925 | 19,234 | $163.17 | 2044-03-15 |
| 448 | job-973435 | warm-digest-19 | billing | West | done | 1 | 2553.5 | 3,204,102 | 1,957,151 | $227.23 | 2044-04-26 |
| 449 | job-907834 | canonical-lease-22 | platform | West | failed | 6 | 1141.3 | 2,370,443 | 803,764 | $342.98 | 2044-06-05 |
| 450 | job-306444 | nested-shard-13 | ingest | North | blocked | 5 | 2901.8 | 3,169,086 | 586,859 | $288.76 | 2044-06-26 |
| 451 | job-449688 | inbound-transcript-29 | infra | Central | done | 2 | 2142.0 | 1,107,840 | 748,659 | $235.63 | 2044-04-04 |
| 452 | job-574425 | warm-buffer-30 | ingest | North | failed | 7 | 1487.5 | 3,597,239 | 2,836,287 | $313.39 | 2044-10-12 |
| 453 | job-512296 | warm-index-10 | search | East | blocked | 6 | 1469.1 | 4,804,230 | 291,701 | $202.29 | 2044-11-23 |
| 454 | job-575611 | delayed-digest-35 | infra | South | skipped | 4 | 1555.9 | 1,208,261 | 456,843 | $97.51 | 2044-10-02 |
| 455 | job-142313 | partial-replica-16 | infra | South | running | 4 | 419.6 | 283,960 | 3,048 | $345.45 | 2044-05-12 |
| 456 | job-145139 | durable-batch-36 | platform | West | done | 7 | 2727.7 | 4,677,518 | 939,131 | $383.11 | 2044-10-13 |
| 457 | job-042537 | ephemeral-buffer-23 | search | West | running | 4 | 1268.7 | 42,441 | 25,485 | $327.80 | 2044-04-26 |
| 458 | job-687349 | delayed-pipeline-39 | billing | Central | queued | 2 | 2764.7 | 2,049,302 | 434,700 | $112.36 | 2044-01-01 |
| 459 | job-349183 | contended-partition-25 | ingest | South | running | 1 | 1983.8 | 4,705,984 | 2,960,398 | $242.41 | 2044-12-04 |
| 460 | job-518553 | ephemeral-lease-35 | ingest | North | queued | 1 | 1355.0 | 907,217 | 214,266 | $276.88 | 2044-07-01 |
| 461 | job-705940 | delayed-scheduler-31 | billing | South | running | 3 | 1470.3 | 1,500,001 | 1,011,934 | $398.04 | 2044-10-04 |
| 462 | job-091139 | warm-cache-11 | ingest | East | skipped | 5 | 980.0 | 2,296,456 | 121,321 | $296.42 | 2044-04-10 |
| 463 | job-013148 | partial-replica-9 | docs | Central | failed | 5 | 1783.6 | 1,275,023 | 1,257,092 | $353.38 | 2044-10-23 |
| 464 | job-801229 | partial-cache-8 | platform | Offshore | failed | 4 | 2791.6 | 2,092,378 | 122,179 | $112.69 | 2044-03-14 |
| 465 | job-325200 | immutable-checkpoint-3 | ingest | East | done | 5 | 359.0 | 860,517 | 307,217 | $385.57 | 2044-04-22 |
| 466 | job-190775 | contended-pipeline-20 | infra | North | running | 6 | 3297.8 | 3,231,674 | 232,283 | $287.97 | 2044-12-08 |
| 467 | job-546145 | partial-gateway-15 | platform | Central | failed | 6 | 3478.2 | 3,266,875 | 2,297,645 | $261.46 | 2044-01-05 |
| 468 | job-656008 | canonical-lease-17 | ingest | South | failed | 2 | 2540.4 | 630,597 | 189,792 | $7.72 | 2044-06-24 |
| 469 | job-003515 | durable-partition-7 | docs | West | blocked | 1 | 2187.4 | 3,894,004 | 1,927,640 | $202.38 | 2044-05-05 |
| 470 | job-899870 | canonical-batch-27 | search | South | queued | 3 | 3140.3 | 931,184 | 814,931 | $391.95 | 2044-02-04 |
| 471 | job-889289 | nested-shard-21 | growth | East | failed | 9 | 3135.1 | 2,636,091 | 2,422,434 | $206.21 | 2044-07-14 |
| 472 | job-668647 | durable-namespace-36 | search | Central | skipped | 6 | 3353.7 | 1,353,211 | 65,588 | $356.15 | 2044-04-24 |
| 473 | job-009587 | warm-pipeline-15 | billing | East | queued | 8 | 2644.2 | 1,700,108 | 1,479,836 | $213.41 | 2044-02-22 |
| 474 | job-071649 | nested-namespace-21 | growth | West | skipped | 8 | 375.2 | 3,864,478 | 3,318,397 | $287.46 | 2044-05-21 |
| 475 | job-818243 | idle-quota-38 | billing | Offshore | failed | 9 | 2670.4 | 3,959,821 | 443,393 | $84.92 | 2044-03-22 |
| 476 | job-665569 | nested-scheduler-35 | growth | East | running | 9 | 114.1 | 2,823,825 | 2,062,287 | $47.31 | 2044-05-26 |
| 477 | job-537890 | nested-cache-16 | billing | West | done | 2 | 2207.0 | 3,032,622 | 2,027,707 | $14.83 | 2044-08-10 |
| 478 | job-180037 | stale-digest-17 | platform | South | queued | 2 | 2284.5 | 3,182,179 | 359,012 | $162.70 | 2044-06-08 |
| 479 | job-562247 | canonical-cursor-10 | search | North | failed | 5 | 3369.3 | 4,964,305 | 3,482,339 | $128.19 | 2044-07-25 |
| 480 | job-004322 | stale-checkpoint-9 | platform | Central | skipped | 5 | 754.8 | 2,622,438 | 142,427 | $19.25 | 2044-08-05 |
| 481 | job-237238 | orphaned-buffer-16 | growth | East | queued | 2 | 189.1 | 176,798 | 16,322 | $69.45 | 2044-11-03 |
| 482 | job-289246 | orphaned-lease-37 | infra | North | running | 8 | 556.9 | 2,061,948 | 1,704,213 | $287.05 | 2044-12-23 |
| 483 | job-757459 | orphaned-registry-25 | platform | Central | done | 7 | 672.4 | 952,894 | 564,912 | $219.47 | 2044-12-26 |
| 484 | job-310415 | orphaned-namespace-29 | platform | South | skipped | 3 | 3424.2 | 3,919,233 | 1,623,089 | $95.84 | 2044-08-10 |
| 485 | job-006536 | contended-scheduler-30 | search | Offshore | queued | 2 | 696.7 | 202,293 | 157,604 | $95.78 | 2044-07-10 |
| 486 | job-098977 | contended-partition-38 | search | South | done | 1 | 460.7 | 1,364,922 | 775,979 | $183.96 | 2044-12-04 |
| 487 | job-430939 | durable-partition-6 | billing | North | queued | 6 | 1493.7 | 180,965 | 166,054 | $57.35 | 2044-07-08 |
| 488 | job-555200 | stale-transcript-17 | infra | West | skipped | 6 | 3396.0 | 4,523,210 | 526,776 | $14.65 | 2044-03-21 |
| 489 | job-653203 | contended-partition-26 | billing | East | done | 4 | 1557.4 | 4,034,234 | 922,242 | $161.38 | 2044-12-08 |
| 490 | job-551425 | stale-ledger-9 | platform | Offshore | failed | 2 | 2470.8 | 4,786,763 | 1,654,186 | $139.41 | 2044-05-25 |
| 491 | job-975773 | inbound-lease-6 | billing | North | failed | 8 | 1116.4 | 2,770,069 | 558,399 | $138.33 | 2044-08-07 |
| 492 | job-479147 | delayed-scheduler-9 | infra | West | done | 5 | 340.9 | 971,776 | 517,942 | $1.46 | 2044-10-01 |
| 493 | job-397873 | delayed-buffer-29 | docs | Offshore | running | 7 | 32.9 | 4,390,857 | 4,385,910 | $242.49 | 2044-05-26 |
| 494 | job-382514 | warm-pipeline-9 | billing | Central | done | 2 | 286.4 | 722,485 | 208,587 | $47.99 | 2044-08-28 |
| 495 | job-678407 | delayed-pipeline-36 | billing | Offshore | blocked | 3 | 3065.1 | 1,870,542 | 137,014 | $302.54 | 2044-08-02 |
| 496 | job-055909 | canonical-cache-15 | platform | South | skipped | 1 | 2260.6 | 4,454,138 | 291,048 | $312.59 | 2044-02-23 |
| 497 | job-756866 | ephemeral-scheduler-20 | billing | West | done | 6 | 2354.4 | 1,199,125 | 250,409 | $172.96 | 2044-11-22 |
| 498 | job-741730 | derived-buffer-16 | search | North | blocked | 5 | 1713.2 | 73,673 | 24,450 | $149.97 | 2044-11-09 |
| 499 | job-406769 | sparse-gateway-16 | ingest | South | blocked | 4 | 2899.0 | 4,075,058 | 3,251,367 | $180.93 | 2044-10-22 |
| 500 | job-553799 | immutable-cache-19 | ingest | East | skipped | 8 | 1725.0 | 1,161,065 | 500,368 | $81.23 | 2044-05-08 |
| 501 | job-541587 | ephemeral-gateway-32 | growth | Offshore | blocked | 6 | 3340.5 | 1,984,740 | 1,648,942 | $43.04 | 2044-11-06 |
| 502 | job-945422 | immutable-envelope-21 | search | Offshore | blocked | 1 | 1414.9 | 4,339,406 | 2,441,876 | $271.64 | 2044-03-01 |
| 503 | job-341854 | contended-shard-3 | billing | Offshore | queued | 3 | 1630.1 | 597,446 | 553,773 | $35.21 | 2044-09-26 |
| 504 | job-392095 | contended-scheduler-11 | infra | Offshore | blocked | 1 | 2854.2 | 2,373,376 | 1,609,592 | $353.02 | 2044-02-02 |
| 505 | job-281324 | inbound-cache-8 | search | West | done | 3 | 218.2 | 1,158,381 | 850,114 | $369.96 | 2044-09-22 |
| 506 | job-116012 | delayed-batch-18 | growth | West | skipped | 1 | 996.1 | 889,026 | 603,039 | $185.84 | 2044-06-09 |
| 507 | job-083943 | inbound-gateway-30 | search | Offshore | failed | 1 | 2019.8 | 4,493,185 | 2,640,102 | $291.19 | 2044-03-02 |
| 508 | job-211002 | delayed-queue-16 | ingest | East | failed | 3 | 1959.9 | 2,857,256 | 931,312 | $316.60 | 2044-04-25 |
| 509 | job-774814 | canonical-batch-5 | growth | South | done | 5 | 1999.6 | 4,896,042 | 4,675,550 | $8.80 | 2044-07-06 |
| 510 | job-714908 | derived-pipeline-15 | search | Central | blocked | 1 | 1428.5 | 3,192,631 | 2,335,061 | $293.11 | 2044-12-10 |
| 511 | job-579419 | delayed-ledger-34 | docs | South | skipped | 5 | 30.3 | 2,613,984 | 1,593,346 | $269.72 | 2044-06-22 |
| 512 | job-415229 | immutable-transcript-40 | ingest | North | failed | 4 | 752.1 | 1,119,556 | 516,337 | $55.54 | 2044-03-11 |
| 513 | job-166967 | contended-quota-5 | infra | West | failed | 3 | 1780.5 | 4,302,113 | 2,343,165 | $231.50 | 2044-04-26 |
| 514 | job-916834 | idle-pipeline-16 | platform | Central | skipped | 4 | 2711.4 | 808,451 | 695,832 | $196.60 | 2044-11-21 |
| 515 | job-115253 | sparse-snapshot-25 | platform | East | queued | 1 | 549.9 | 447,441 | 333,377 | $20.38 | 2044-10-01 |
| 516 | job-850845 | derived-gateway-40 | search | North | skipped | 6 | 1720.1 | 1,340,269 | 189,889 | $373.20 | 2044-03-28 |
| 517 | job-567425 | contended-digest-17 | growth | South | failed | 7 | 2027.7 | 1,625,105 | 501,258 | $274.30 | 2044-07-01 |
| 518 | job-705716 | durable-snapshot-10 | platform | West | queued | 3 | 2933.2 | 2,315,468 | 1,728,951 | $394.00 | 2044-12-27 |
| 519 | job-621081 | nested-quota-4 | ingest | Offshore | done | 6 | 362.4 | 4,722,632 | 1,030,117 | $49.92 | 2044-08-03 |
| 520 | job-566084 | orphaned-partition-17 | growth | East | skipped | 7 | 1280.1 | 3,081,148 | 2,156,878 | $110.80 | 2044-02-28 |
| 521 | job-580972 | stale-batch-39 | ingest | East | queued | 2 | 945.4 | 2,797,327 | 627,098 | $205.39 | 2044-06-05 |
| 522 | job-618499 | immutable-checkpoint-22 | search | West | blocked | 7 | 305.2 | 1,554,508 | 765,116 | $264.20 | 2044-02-18 |
| 523 | job-381399 | derived-namespace-17 | billing | Central | failed | 3 | 1659.8 | 1,943,732 | 1,344,752 | $190.51 | 2044-04-18 |
| 524 | job-152784 | inbound-cache-38 | growth | North | done | 4 | 1894.3 | 2,621,899 | 130,151 | $308.29 | 2044-01-22 |
| 525 | job-419011 | partial-queue-29 | search | East | blocked | 4 | 1326.4 | 1,959,999 | 1,428,886 | $286.43 | 2044-02-15 |
| 526 | job-531679 | partial-index-13 | ingest | South | running | 4 | 2447.5 | 4,520,358 | 1,382,446 | $318.07 | 2044-03-13 |
| 527 | job-554130 | partial-queue-8 | platform | Offshore | running | 1 | 2124.7 | 2,154,582 | 1,506,282 | $29.91 | 2044-05-16 |
| 528 | job-189123 | ephemeral-partition-6 | platform | South | failed | 9 | 2197.4 | 4,330,585 | 2,939,029 | $74.36 | 2044-04-11 |
| 529 | job-805743 | immutable-pipeline-19 | platform | Offshore | skipped | 1 | 1395.1 | 3,990,357 | 3,844,232 | $198.16 | 2044-02-26 |
| 530 | job-841567 | canonical-digest-16 | ingest | West | failed | 8 | 3399.9 | 973,107 | 234,799 | $107.12 | 2044-07-17 |
| 531 | job-162129 | canonical-manifest-19 | growth | West | failed | 4 | 2070.4 | 3,867,092 | 1,990,484 | $226.20 | 2044-02-09 |
| 532 | job-737850 | stale-pipeline-31 | growth | East | blocked | 1 | 2675.0 | 4,066,408 | 1,495,218 | $387.16 | 2044-07-23 |
| 533 | job-628056 | idle-quota-20 | ingest | Central | skipped | 8 | 2301.5 | 3,971,884 | 1,416,246 | $45.46 | 2044-10-17 |
| 534 | job-188686 | immutable-cursor-27 | search | Central | done | 2 | 2647.0 | 4,965,050 | 3,646,377 | $142.20 | 2044-06-25 |
| 535 | job-403210 | contended-partition-40 | ingest | Central | queued | 1 | 2312.9 | 1,236,781 | 1,004,289 | $101.09 | 2044-12-06 |
| 536 | job-066978 | stale-buffer-18 | ingest | Offshore | blocked | 1 | 1358.2 | 4,873,707 | 205,511 | $350.18 | 2044-06-07 |
| 537 | job-384798 | durable-shard-40 | platform | West | done | 9 | 611.2 | 612,518 | 377,096 | $141.96 | 2044-08-16 |
| 538 | job-197418 | sparse-lease-15 | ingest | South | blocked | 7 | 519.7 | 4,020,219 | 3,575,404 | $284.94 | 2044-04-15 |
| 539 | job-883531 | contended-gateway-26 | billing | East | done | 6 | 1564.7 | 972,907 | 544,951 | $379.38 | 2044-12-12 |
| 540 | job-523570 | idle-namespace-2 | search | Offshore | running | 6 | 201.6 | 900,005 | 621,222 | $194.69 | 2044-10-28 |
| 541 | job-823280 | immutable-registry-13 | platform | West | queued | 6 | 625.9 | 2,247,468 | 2,036,186 | $35.90 | 2044-12-28 |
| 542 | job-058273 | stale-replica-35 | billing | North | blocked | 2 | 549.7 | 391,284 | 228,758 | $236.52 | 2044-08-23 |
| 543 | job-259178 | warm-partition-13 | platform | South | failed | 1 | 730.7 | 754,740 | 164,425 | $124.83 | 2044-05-17 |
| 544 | job-044735 | sparse-lease-22 | platform | South | queued | 7 | 1347.7 | 1,422,658 | 1,397,837 | $386.77 | 2044-01-13 |
| 545 | job-026809 | contended-digest-16 | platform | South | done | 4 | 3000.3 | 2,936,060 | 1,829,775 | $335.73 | 2044-10-06 |
| 546 | job-648760 | derived-transcript-26 | growth | Central | done | 9 | 354.2 | 3,942,562 | 266,223 | $176.14 | 2044-08-03 |
| 547 | job-826811 | canonical-envelope-32 | infra | Central | running | 5 | 1163.1 | 67,416 | 29,102 | $371.46 | 2044-10-27 |
| 548 | job-596803 | durable-partition-38 | docs | North | blocked | 4 | 1456.4 | 2,449,331 | 104,756 | $276.78 | 2044-10-19 |
| 549 | job-079448 | durable-gateway-26 | infra | East | blocked | 3 | 2776.7 | 75,721 | 71,453 | $305.82 | 2044-09-02 |
| 550 | job-355263 | derived-queue-2 | search | Central | done | 6 | 2019.4 | 2,690,282 | 77,933 | $354.72 | 2044-04-17 |
| 551 | job-598857 | contended-replica-31 | billing | South | done | 3 | 158.6 | 2,678,197 | 184,268 | $57.75 | 2044-04-18 |
| 552 | job-989042 | partial-buffer-40 | ingest | South | done | 6 | 3140.0 | 2,629,720 | 906,264 | $82.68 | 2044-01-08 |
| 553 | job-535287 | canonical-envelope-5 | billing | Offshore | queued | 3 | 450.8 | 1,785,993 | 76,360 | $89.80 | 2044-12-08 |
| 554 | job-083404 | partial-lease-13 | ingest | East | running | 1 | 1691.0 | 3,185,221 | 1,573,248 | $252.43 | 2044-07-20 |
| 555 | job-191969 | canonical-registry-23 | ingest | East | blocked | 9 | 448.0 | 4,801,787 | 4,726,300 | $17.82 | 2044-08-01 |
| 556 | job-880548 | warm-queue-40 | search | Offshore | running | 8 | 897.3 | 594,601 | 54,687 | $137.45 | 2044-07-24 |
| 557 | job-944160 | partial-replica-10 | growth | Offshore | done | 9 | 2489.3 | 2,680,962 | 705,964 | $101.74 | 2044-10-10 |
| 558 | job-276675 | contended-digest-19 | search | North | queued | 3 | 2203.0 | 4,993,101 | 1,527,577 | $236.44 | 2044-03-06 |
| 559 | job-210601 | delayed-replica-1 | docs | Offshore | failed | 5 | 3177.6 | 658,175 | 598,355 | $109.56 | 2044-07-19 |
| 560 | job-282490 | immutable-namespace-20 | billing | South | failed | 2 | 1571.6 | 3,714,336 | 768,649 | $127.69 | 2044-07-15 |
| 561 | job-895763 | derived-quota-39 | docs | Central | done | 4 | 152.0 | 3,381,449 | 1,010,911 | $203.74 | 2044-10-25 |
| 562 | job-804447 | canonical-partition-32 | platform | South | failed | 1 | 661.6 | 2,121,269 | 781,675 | $89.85 | 2044-09-24 |
| 563 | job-604644 | canonical-ledger-28 | infra | South | running | 3 | 3481.7 | 4,096,769 | 2,133,551 | $340.47 | 2044-06-10 |
| 564 | job-892079 | delayed-batch-3 | platform | Central | failed | 4 | 1436.2 | 4,264,109 | 3,955,629 | $122.83 | 2044-06-09 |
| 565 | job-576102 | nested-pipeline-29 | search | West | running | 7 | 622.5 | 3,769,889 | 3,667,223 | $119.86 | 2044-11-02 |
| 566 | job-768556 | ephemeral-gateway-39 | search | Central | running | 4 | 1151.1 | 4,000,668 | 1,666,411 | $57.73 | 2044-10-06 |
| 567 | job-673369 | partial-snapshot-15 | platform | South | queued | 7 | 154.5 | 2,147,272 | 329,649 | $276.68 | 2044-05-05 |
| 568 | job-568146 | warm-transcript-11 | search | Central | queued | 4 | 1378.6 | 4,449,076 | 4,213,450 | $192.84 | 2044-12-16 |
| 569 | job-956495 | derived-digest-13 | growth | West | queued | 5 | 1476.1 | 1,351,942 | 987,191 | $146.32 | 2044-11-08 |
| 570 | job-160783 | nested-quota-14 | search | West | queued | 8 | 2945.6 | 1,066,926 | 669,414 | $43.26 | 2044-12-14 |
| 571 | job-494301 | orphaned-queue-38 | billing | South | failed | 2 | 2114.4 | 1,639,728 | 1,416,023 | $193.50 | 2044-03-04 |
| 572 | job-857932 | ephemeral-gateway-29 | infra | North | done | 5 | 2125.7 | 1,741,588 | 20,860 | $46.66 | 2044-01-12 |
| 573 | job-729081 | delayed-cache-3 | docs | East | running | 6 | 3363.8 | 3,204,600 | 2,238,704 | $387.95 | 2044-07-17 |
| 574 | job-162958 | durable-partition-15 | platform | Central | running | 6 | 13.9 | 3,703,109 | 2,313,857 | $175.40 | 2044-11-22 |
| 575 | job-559272 | orphaned-lease-28 | billing | South | failed | 2 | 1357.5 | 171,152 | 155,893 | $113.99 | 2044-05-26 |
| 576 | job-550978 | partial-ledger-23 | search | Central | skipped | 5 | 2217.8 | 119,198 | 13,935 | $336.73 | 2044-11-16 |
| 577 | job-558650 | sparse-partition-36 | search | North | skipped | 8 | 1975.9 | 515,590 | 393,787 | $282.94 | 2044-02-12 |
| 578 | job-064085 | immutable-transcript-35 | search | East | done | 6 | 258.9 | 1,850,930 | 370,663 | $332.15 | 2044-09-11 |
| 579 | job-196161 | sparse-namespace-21 | ingest | West | done | 3 | 911.9 | 2,011,847 | 768,106 | $249.07 | 2044-08-15 |
| 580 | job-152176 | derived-queue-13 | search | South | running | 7 | 952.4 | 3,480,767 | 2,886,032 | $143.59 | 2044-10-06 |
| 581 | job-413071 | derived-partition-12 | docs | Offshore | queued | 9 | 2374.4 | 4,353,510 | 3,229,768 | $93.95 | 2044-06-01 |
| 582 | job-705777 | nested-checkpoint-26 | billing | Offshore | skipped | 5 | 1695.0 | 2,736,232 | 1,210,344 | $155.48 | 2044-12-04 |
| 583 | job-472831 | stale-ledger-21 | billing | Central | queued | 6 | 3037.7 | 172,512 | 79,580 | $107.84 | 2044-11-23 |
| 584 | job-817871 | stale-ledger-34 | ingest | South | blocked | 7 | 336.1 | 3,786,107 | 160,199 | $249.29 | 2044-10-05 |
| 585 | job-526406 | inbound-replica-40 | docs | Central | blocked | 6 | 2799.9 | 3,563,053 | 1,694,903 | $334.06 | 2044-10-28 |
| 586 | job-954468 | idle-queue-10 | search | West | queued | 8 | 2394.9 | 3,230,113 | 1,333,573 | $231.92 | 2044-11-21 |
| 587 | job-077110 | canonical-registry-21 | growth | South | blocked | 6 | 3244.9 | 4,126,983 | 3,252,526 | $173.18 | 2044-11-02 |
| 588 | job-596085 | partial-transcript-30 | growth | Central | skipped | 6 | 3575.1 | 791,808 | 399,725 | $265.36 | 2044-03-13 |
| 589 | job-480498 | delayed-partition-4 | billing | Central | blocked | 7 | 1342.5 | 3,187,657 | 2,325,828 | $27.99 | 2044-08-16 |
| 590 | job-089351 | durable-queue-39 | infra | East | running | 5 | 1487.2 | 4,499,955 | 1,987,234 | $126.32 | 2044-02-06 |
| 591 | job-065392 | partial-gateway-9 | search | East | blocked | 2 | 1905.7 | 1,506,628 | 1,082,393 | $48.55 | 2044-10-10 |
| 592 | job-954245 | partial-registry-18 | search | Central | blocked | 9 | 2335.2 | 1,785,609 | 505,027 | $262.06 | 2044-02-25 |
| 593 | job-987986 | warm-checkpoint-3 | growth | Central | blocked | 9 | 2311.4 | 2,960,142 | 1,187,237 | $358.74 | 2044-04-16 |
| 594 | job-367777 | contended-quota-36 | docs | North | failed | 8 | 3249.3 | 3,733,795 | 886,564 | $52.41 | 2044-09-13 |
| 595 | job-767877 | canonical-replica-27 | docs | East | skipped | 8 | 497.8 | 391,148 | 389,764 | $246.92 | 2044-01-06 |
| 596 | job-400377 | nested-transcript-8 | platform | Central | failed | 5 | 169.5 | 2,341,813 | 2,318,736 | $239.53 | 2044-05-02 |
| 597 | job-495624 | idle-checkpoint-17 | billing | West | done | 9 | 1690.3 | 1,092,305 | 1,086,439 | $301.36 | 2044-09-02 |
| 598 | job-793533 | idle-batch-30 | docs | North | skipped | 3 | 2861.7 | 3,571,351 | 3,330,154 | $24.16 | 2044-06-13 |
| 599 | job-829803 | stale-ledger-9 | ingest | North | running | 4 | 1484.4 | 957,717 | 459,649 | $143.65 | 2044-07-08 |
| 600 | job-310640 | ephemeral-lease-29 | docs | Offshore | failed | 6 | 811.2 | 4,235,829 | 2,651,478 | $274.28 | 2044-07-24 |
| 601 | job-851372 | ephemeral-envelope-36 | billing | North | running | 1 | 880.2 | 2,783,385 | 1,071,147 | $322.33 | 2044-07-03 |
| 602 | job-479467 | nested-cache-38 | ingest | North | queued | 9 | 654.0 | 3,105,415 | 1,050,962 | $253.15 | 2044-07-09 |
| 603 | job-588341 | delayed-registry-40 | docs | West | done | 3 | 2104.1 | 1,245,423 | 297,229 | $199.61 | 2044-05-13 |
| 604 | job-207902 | contended-quota-10 | infra | South | queued | 9 | 915.3 | 3,749,180 | 3,294,951 | $200.24 | 2044-06-20 |
| 605 | job-842960 | derived-snapshot-35 | ingest | North | skipped | 4 | 819.4 | 850,307 | 715,382 | $34.91 | 2044-11-03 |
| 606 | job-639230 | contended-lease-13 | search | North | failed | 8 | 2894.0 | 1,686,815 | 1,196,210 | $179.12 | 2044-09-23 |
| 607 | job-601694 | durable-manifest-1 | ingest | South | blocked | 1 | 1489.6 | 4,747,681 | 585,799 | $90.89 | 2044-02-15 |
| 608 | job-770752 | sparse-scheduler-33 | ingest | Central | running | 6 | 391.3 | 2,640,419 | 502,159 | $275.55 | 2044-03-22 |
| 609 | job-992619 | canonical-scheduler-6 | infra | North | failed | 5 | 3432.0 | 2,148,467 | 96,069 | $362.26 | 2044-07-26 |
| 610 | job-969429 | derived-shard-36 | growth | North | running | 7 | 2495.1 | 2,077,556 | 1,173,894 | $104.74 | 2044-09-09 |
| 611 | job-066051 | orphaned-digest-11 | growth | South | blocked | 1 | 3160.8 | 2,897,961 | 2,548,426 | $226.47 | 2044-05-20 |
| 612 | job-866938 | stale-envelope-12 | platform | West | done | 4 | 2018.5 | 1,555,487 | 176,279 | $270.03 | 2044-06-14 |
| 613 | job-962821 | derived-manifest-13 | billing | West | running | 6 | 3111.8 | 949,652 | 281,825 | $375.31 | 2044-05-28 |
| 614 | job-942758 | durable-cache-23 | ingest | Offshore | running | 6 | 3596.6 | 3,794,001 | 1,047,155 | $37.15 | 2044-08-24 |
| 615 | job-576623 | stale-cursor-40 | infra | North | running | 3 | 1582.2 | 912,933 | 110,887 | $334.61 | 2044-07-11 |
| 616 | job-154988 | ephemeral-shard-27 | billing | East | blocked | 2 | 987.3 | 3,344,979 | 73,430 | $209.01 | 2044-07-21 |
| 617 | job-360757 | idle-cache-26 | platform | North | blocked | 3 | 3315.7 | 1,926,084 | 643,978 | $311.47 | 2044-06-03 |
| 618 | job-711074 | partial-registry-9 | growth | West | queued | 2 | 1427.0 | 1,763,444 | 61,108 | $299.84 | 2044-12-09 |
| 619 | job-603417 | delayed-cursor-23 | billing | West | skipped | 3 | 1339.0 | 4,854,764 | 933,236 | $59.77 | 2044-08-22 |
| 620 | job-308349 | warm-shard-16 | docs | Central | queued | 7 | 1604.4 | 4,961,762 | 2,024,104 | $51.90 | 2044-12-03 |
| 621 | job-962813 | stale-namespace-19 | growth | East | blocked | 3 | 1550.5 | 1,292,147 | 1,066,188 | $214.09 | 2044-02-04 |
| 622 | job-729511 | canonical-shard-22 | docs | East | queued | 5 | 801.2 | 867,468 | 230,672 | $226.72 | 2044-03-18 |
| 623 | job-509324 | sparse-envelope-15 | docs | West | failed | 3 | 108.0 | 4,434,832 | 854,010 | $360.36 | 2044-06-15 |
| 624 | job-994456 | derived-digest-25 | search | Central | failed | 7 | 3466.5 | 3,572,221 | 393,846 | $222.38 | 2044-01-03 |
| 625 | job-302039 | canonical-buffer-11 | billing | East | queued | 5 | 2767.2 | 169,079 | 63,398 | $75.23 | 2044-05-02 |
| 626 | job-021858 | stale-cursor-2 | infra | East | failed | 4 | 3352.1 | 3,100,466 | 1,575,721 | $184.66 | 2044-01-08 |
| 627 | job-779954 | idle-buffer-3 | growth | East | skipped | 6 | 769.3 | 3,204,078 | 1,407,088 | $156.70 | 2044-01-12 |
| 628 | job-702977 | canonical-cursor-20 | platform | North | skipped | 9 | 3028.6 | 3,977,427 | 3,289,286 | $371.76 | 2044-08-17 |
| 629 | job-027521 | stale-cache-11 | docs | Offshore | queued | 4 | 1653.3 | 855,041 | 656,061 | $120.31 | 2044-11-15 |
| 630 | job-006904 | nested-digest-21 | search | North | done | 1 | 2837.7 | 2,604,933 | 1,414,404 | $336.49 | 2044-05-02 |
| 631 | job-537191 | idle-registry-20 | docs | East | queued | 2 | 231.6 | 2,782,934 | 1,857,956 | $97.45 | 2044-06-18 |
| 632 | job-752194 | durable-envelope-21 | search | West | blocked | 4 | 1159.9 | 1,718,135 | 1,286,437 | $165.73 | 2044-03-22 |
| 633 | job-039342 | nested-queue-23 | billing | South | queued | 3 | 1600.9 | 1,163,523 | 237,739 | $267.71 | 2044-12-28 |
| 634 | job-768436 | immutable-cache-4 | docs | West | skipped | 5 | 1438.6 | 3,902,102 | 3,225,160 | $168.31 | 2044-04-05 |
| 635 | job-915400 | delayed-partition-18 | growth | West | queued | 2 | 2054.9 | 2,705,488 | 2,251,541 | $293.51 | 2044-02-12 |
| 636 | job-694111 | sparse-replica-11 | infra | East | failed | 4 | 1837.2 | 444,950 | 72,513 | $268.49 | 2044-06-05 |
| 637 | job-060791 | contended-index-34 | docs | North | blocked | 1 | 1472.9 | 2,685,061 | 2,231,716 | $288.96 | 2044-06-06 |
| 638 | job-602963 | sparse-checkpoint-2 | search | North | blocked | 5 | 919.3 | 4,242,708 | 354,289 | $394.50 | 2044-08-01 |
| 639 | job-520234 | sparse-digest-38 | search | South | running | 9 | 759.2 | 1,132,035 | 902,660 | $78.24 | 2044-08-15 |
| 640 | job-661649 | warm-batch-1 | growth | Offshore | queued | 6 | 3148.4 | 2,660,874 | 1,256,984 | $359.58 | 2044-02-28 |
| 641 | job-712982 | sparse-shard-36 | docs | Offshore | blocked | 1 | 74.7 | 1,023,975 | 233,986 | $306.55 | 2044-06-17 |
| 642 | job-384090 | stale-lease-29 | platform | North | done | 7 | 1490.2 | 720,932 | 569,619 | $150.92 | 2044-06-27 |
| 643 | job-545597 | warm-namespace-35 | billing | Offshore | queued | 1 | 3257.1 | 2,663,402 | 2,503,792 | $97.59 | 2044-08-27 |
| 644 | job-068760 | warm-ledger-32 | billing | West | failed | 1 | 616.8 | 990,948 | 193,423 | $362.55 | 2044-02-20 |
| 645 | job-063284 | nested-manifest-39 | platform | North | queued | 7 | 2712.8 | 586,692 | 453,838 | $349.32 | 2044-11-26 |
| 646 | job-374121 | delayed-scheduler-30 | search | North | running | 1 | 1435.5 | 3,358,228 | 1,687,761 | $340.78 | 2044-08-27 |
| 647 | job-277426 | stale-transcript-39 | growth | Offshore | blocked | 8 | 617.6 | 3,535,709 | 1,212,714 | $275.49 | 2044-06-21 |
| 648 | job-235408 | ephemeral-snapshot-2 | billing | Offshore | blocked | 9 | 1318.1 | 4,260,289 | 1,879,216 | $91.55 | 2044-02-15 |
| 649 | job-192781 | sparse-snapshot-1 | platform | Central | done | 5 | 2711.7 | 3,569,500 | 447,534 | $94.89 | 2044-03-19 |
| 650 | job-641554 | contended-namespace-19 | growth | Offshore | running | 2 | 2868.0 | 3,419,432 | 181,633 | $362.69 | 2044-10-21 |
| 651 | job-583296 | partial-index-20 | platform | Offshore | running | 7 | 959.6 | 58,744 | 41,696 | $100.01 | 2044-09-05 |
| 652 | job-519481 | partial-lease-21 | growth | South | done | 6 | 56.3 | 1,272,352 | 420,333 | $177.56 | 2044-04-15 |
| 653 | job-862152 | durable-ledger-5 | billing | Central | queued | 2 | 355.6 | 702,694 | 80,334 | $73.40 | 2044-06-10 |
| 654 | job-169943 | durable-shard-10 | billing | South | running | 7 | 1980.6 | 1,690,579 | 1,142,439 | $309.85 | 2044-09-11 |
| 655 | job-364070 | derived-partition-26 | docs | West | running | 6 | 28.8 | 2,823,884 | 1,720,568 | $174.62 | 2044-08-05 |
| 656 | job-181507 | derived-namespace-28 | infra | Central | queued | 3 | 1416.2 | 3,255,610 | 1,924,564 | $198.06 | 2044-02-18 |
| 657 | job-445617 | partial-quota-36 | ingest | West | failed | 5 | 3197.3 | 2,534,054 | 2,288,902 | $92.73 | 2044-12-16 |
| 658 | job-405617 | immutable-quota-35 | platform | Offshore | blocked | 1 | 3002.2 | 4,493,009 | 1,488,598 | $87.31 | 2044-01-05 |
| 659 | job-532587 | inbound-checkpoint-1 | search | West | blocked | 1 | 1443.3 | 1,800,114 | 629,959 | $92.20 | 2044-12-23 |
| 660 | job-019090 | contended-queue-17 | ingest | North | queued | 1 | 1408.5 | 1,365,388 | 896,741 | $20.69 | 2044-08-04 |
| 661 | job-903039 | stale-partition-28 | billing | North | done | 1 | 3360.8 | 1,330,945 | 1,253,755 | $230.05 | 2044-06-20 |
| 662 | job-802736 | ephemeral-batch-39 | platform | South | running | 4 | 1267.7 | 4,874,195 | 303,542 | $146.43 | 2044-06-26 |
| 663 | job-492371 | canonical-queue-6 | docs | East | skipped | 7 | 1540.2 | 1,354,588 | 1,311,418 | $46.25 | 2044-01-23 |
| 664 | job-854097 | stale-partition-15 | search | East | queued | 2 | 2220.3 | 857,938 | 529,395 | $354.56 | 2044-09-26 |
| 665 | job-033969 | stale-shard-19 | docs | Central | skipped | 8 | 3144.1 | 140,214 | 28,499 | $74.37 | 2044-11-25 |
| 666 | job-742552 | canonical-scheduler-35 | billing | West | queued | 6 | 1226.2 | 905,938 | 499,088 | $150.05 | 2044-08-28 |
| 667 | job-346847 | warm-shard-14 | ingest | East | failed | 9 | 784.2 | 4,898,243 | 1,026,671 | $93.68 | 2044-12-13 |
| 668 | job-900554 | ephemeral-quota-12 | billing | West | failed | 6 | 2050.9 | 2,504,254 | 1,083,186 | $146.76 | 2044-03-10 |
| 669 | job-919639 | sparse-replica-8 | platform | Offshore | queued | 2 | 882.4 | 3,474,474 | 2,535,241 | $305.66 | 2044-05-19 |
| 670 | job-670590 | derived-digest-2 | growth | East | running | 1 | 3085.0 | 2,056,364 | 1,080,561 | $344.43 | 2044-07-18 |
| 671 | job-870454 | orphaned-checkpoint-40 | infra | East | skipped | 7 | 2515.9 | 1,448,900 | 441,646 | $351.81 | 2044-09-08 |
| 672 | job-337540 | idle-cache-31 | ingest | North | failed | 6 | 144.6 | 154,952 | 16,356 | $229.09 | 2044-03-12 |
| 673 | job-348794 | derived-batch-21 | billing | East | done | 7 | 459.7 | 1,256,037 | 64,269 | $257.36 | 2044-10-04 |
| 674 | job-608394 | inbound-lease-27 | search | Offshore | blocked | 2 | 3372.0 | 2,810,831 | 2,303,043 | $118.87 | 2044-06-18 |
| 675 | job-461947 | ephemeral-index-19 | docs | North | blocked | 5 | 3551.7 | 956,747 | 557,863 | $135.28 | 2044-01-22 |
| 676 | job-516044 | stale-cache-1 | billing | South | blocked | 5 | 2046.4 | 719,586 | 223,702 | $396.87 | 2044-10-02 |
| 677 | job-650449 | partial-registry-10 | growth | South | queued | 8 | 110.5 | 4,079,947 | 1,613,963 | $128.75 | 2044-01-14 |
| 678 | job-835639 | inbound-snapshot-28 | ingest | North | running | 5 | 315.0 | 2,377,528 | 531,902 | $331.42 | 2044-01-02 |
| 679 | job-267061 | durable-manifest-29 | growth | North | done | 5 | 2112.2 | 4,195,653 | 2,228,506 | $245.85 | 2044-02-09 |
| 680 | job-770086 | orphaned-queue-40 | billing | North | blocked | 5 | 2928.6 | 3,016,214 | 1,133,792 | $93.59 | 2044-08-17 |
| 681 | job-034328 | nested-manifest-6 | growth | East | done | 2 | 564.9 | 29,476 | 27,581 | $201.70 | 2044-02-01 |
| 682 | job-273395 | idle-gateway-31 | ingest | Offshore | blocked | 8 | 2373.0 | 2,617,377 | 1,765,086 | $266.26 | 2044-11-09 |
| 683 | job-431774 | idle-scheduler-14 | search | North | blocked | 7 | 902.8 | 2,275,645 | 1,893,565 | $12.53 | 2044-02-13 |
| 684 | job-880520 | idle-namespace-27 | infra | Central | done | 5 | 2139.3 | 4,869,646 | 1,444,707 | $333.35 | 2044-09-24 |
| 685 | job-481992 | nested-lease-5 | platform | West | queued | 4 | 1546.3 | 4,974,063 | 4,718,917 | $28.85 | 2044-08-04 |
| 686 | job-207652 | nested-snapshot-12 | platform | East | skipped | 5 | 901.8 | 3,390,771 | 2,390,958 | $235.26 | 2044-01-09 |
| 687 | job-458738 | ephemeral-transcript-23 | docs | Offshore | blocked | 4 | 1865.1 | 3,325,738 | 584,468 | $221.85 | 2044-04-01 |
| 688 | job-113870 | orphaned-cache-28 | ingest | Offshore | skipped | 4 | 1087.8 | 1,553,187 | 959,273 | $372.23 | 2044-04-04 |
| 689 | job-580347 | immutable-envelope-10 | search | West | blocked | 2 | 2044.8 | 3,652,681 | 3,531,253 | $264.60 | 2044-02-23 |
| 690 | job-132431 | delayed-index-30 | search | Central | queued | 2 | 119.4 | 3,975,881 | 2,916,010 | $392.16 | 2044-04-01 |
| 691 | job-033246 | warm-partition-27 | billing | North | skipped | 4 | 400.9 | 1,607,868 | 1,452,259 | $293.37 | 2044-05-17 |
| 692 | job-502637 | inbound-queue-27 | infra | Offshore | blocked | 7 | 2206.9 | 950,787 | 569,627 | $334.56 | 2044-08-13 |
| 693 | job-626666 | orphaned-manifest-3 | platform | North | running | 6 | 481.8 | 4,503,169 | 567,237 | $148.20 | 2044-05-14 |
| 694 | job-002557 | immutable-quota-25 | billing | North | running | 3 | 2845.6 | 2,911,404 | 1,964,734 | $166.63 | 2044-09-09 |
| 695 | job-581642 | stale-registry-19 | search | East | failed | 7 | 1801.1 | 2,890,626 | 2,729,526 | $119.92 | 2044-07-06 |
| 696 | job-857015 | contended-lease-27 | billing | Central | failed | 1 | 2713.5 | 2,971,845 | 2,771,486 | $337.90 | 2044-12-21 |
| 697 | job-458202 | stale-digest-17 | infra | East | queued | 3 | 1569.2 | 3,605,225 | 2,279,784 | $7.89 | 2044-10-19 |
| 698 | job-506449 | orphaned-buffer-13 | platform | Central | failed | 6 | 579.0 | 291,493 | 84,046 | $115.39 | 2044-04-21 |
| 699 | job-886783 | orphaned-envelope-35 | billing | Central | running | 3 | 2975.6 | 2,100,362 | 505,358 | $144.58 | 2044-09-06 |
| 700 | job-107271 | stale-cursor-15 | search | East | running | 5 | 717.6 | 1,728,483 | 606,774 | $172.90 | 2044-02-17 |
| 701 | job-129844 | contended-checkpoint-39 | ingest | East | queued | 2 | 2037.9 | 4,182,665 | 3,833,847 | $72.59 | 2044-09-16 |
| 702 | job-888029 | partial-registry-31 | ingest | East | queued | 8 | 2893.9 | 1,862,900 | 1,121,440 | $369.04 | 2044-01-14 |
| 703 | job-043282 | contended-queue-13 | docs | North | queued | 7 | 2902.6 | 959,649 | 189,072 | $205.67 | 2044-02-20 |
| 704 | job-924393 | ephemeral-queue-23 | growth | Central | queued | 4 | 617.5 | 4,748,773 | 1,554,839 | $15.38 | 2044-03-16 |
| 705 | job-324379 | partial-queue-6 | ingest | South | skipped | 3 | 3036.7 | 461,956 | 385,209 | $85.47 | 2044-10-21 |
| 706 | job-878119 | delayed-quota-38 | growth | Offshore | running | 3 | 526.1 | 3,963,288 | 1,642,943 | $46.81 | 2044-06-28 |
| 707 | job-922225 | immutable-queue-18 | billing | North | skipped | 9 | 2875.6 | 2,443,213 | 1,862,708 | $315.57 | 2044-09-19 |
| 708 | job-462453 | warm-index-1 | platform | Offshore | skipped | 5 | 3213.0 | 3,011,576 | 177,733 | $89.71 | 2044-09-07 |
| 709 | job-735621 | warm-lease-30 | docs | Central | queued | 4 | 692.6 | 2,949,451 | 964,319 | $149.51 | 2044-03-24 |
| 710 | job-980426 | partial-quota-33 | platform | South | queued | 6 | 760.1 | 4,213,102 | 4,001,083 | $139.11 | 2044-05-04 |
| 711 | job-573538 | orphaned-queue-6 | docs | South | skipped | 3 | 2629.9 | 3,957,938 | 834,246 | $312.04 | 2044-11-17 |
| 712 | job-640745 | contended-checkpoint-35 | billing | Central | blocked | 6 | 2954.2 | 1,238,480 | 1,230,816 | $24.65 | 2044-08-23 |
| 713 | job-804974 | canonical-envelope-30 | platform | West | failed | 1 | 1764.1 | 1,001,906 | 573,610 | $213.79 | 2044-10-11 |
| 714 | job-622420 | stale-namespace-30 | platform | West | skipped | 6 | 1958.5 | 4,564,483 | 523,107 | $93.91 | 2044-09-03 |
| 715 | job-449701 | contended-checkpoint-15 | ingest | Offshore | queued | 9 | 132.1 | 96,257 | 28,289 | $21.51 | 2044-02-14 |
| 716 | job-657534 | ephemeral-queue-14 | infra | Offshore | skipped | 1 | 3004.9 | 1,663,331 | 1,569,450 | $389.37 | 2044-06-08 |
| 717 | job-523644 | durable-replica-13 | search | West | failed | 3 | 1895.5 | 393,806 | 224,435 | $372.66 | 2044-11-21 |
| 718 | job-288432 | immutable-replica-38 | docs | Offshore | running | 4 | 537.9 | 3,721,683 | 2,673,109 | $279.40 | 2044-04-19 |
| 719 | job-616533 | warm-digest-16 | search | Offshore | done | 8 | 3022.3 | 1,503,587 | 216,153 | $170.68 | 2044-05-05 |
| 720 | job-963834 | immutable-buffer-31 | infra | West | done | 7 | 1308.7 | 1,868,176 | 1,368,815 | $361.34 | 2044-12-10 |
| 721 | job-721975 | nested-cursor-8 | infra | Central | queued | 8 | 2168.9 | 3,304,406 | 1,496,654 | $14.96 | 2044-11-20 |
| 722 | job-617860 | idle-partition-36 | platform | South | skipped | 3 | 257.8 | 1,818,173 | 1,076,730 | $71.05 | 2044-10-24 |
| 723 | job-821710 | orphaned-buffer-4 | infra | North | failed | 5 | 662.2 | 1,245,989 | 4,094 | $106.52 | 2044-04-13 |
| 724 | job-746190 | immutable-shard-36 | ingest | West | failed | 3 | 1038.2 | 4,268,587 | 51,678 | $56.20 | 2044-06-19 |
| 725 | job-554412 | inbound-envelope-32 | search | South | failed | 6 | 3090.9 | 3,011,507 | 1,888,843 | $125.83 | 2044-06-25 |
| 726 | job-169580 | ephemeral-pipeline-16 | growth | East | skipped | 6 | 2196.7 | 2,256,647 | 2,011,601 | $6.24 | 2044-05-27 |
| 727 | job-748164 | contended-partition-28 | growth | West | queued | 9 | 3561.4 | 1,231,886 | 1,016,581 | $227.46 | 2044-09-27 |
| 728 | job-960570 | immutable-ledger-21 | search | South | done | 8 | 1818.0 | 1,045,130 | 920,966 | $171.67 | 2044-06-18 |
| 729 | job-434067 | durable-pipeline-29 | growth | Central | queued | 4 | 766.2 | 3,400,525 | 3,162,271 | $376.95 | 2044-02-13 |
| 730 | job-896738 | inbound-checkpoint-20 | billing | Central | blocked | 7 | 1499.5 | 724,082 | 464,836 | $254.67 | 2044-04-24 |
| 731 | job-588111 | partial-replica-18 | infra | East | failed | 3 | 2126.3 | 1,793,840 | 932,396 | $329.42 | 2044-02-11 |
| 732 | job-935342 | delayed-lease-19 | ingest | Central | queued | 4 | 3558.8 | 500,659 | 143,579 | $40.81 | 2044-06-28 |
| 733 | job-370780 | nested-partition-12 | docs | South | skipped | 4 | 1648.8 | 524,888 | 283,998 | $137.41 | 2044-07-15 |
| 734 | job-714281 | nested-pipeline-3 | platform | South | running | 8 | 3060.3 | 166,018 | 82,428 | $99.28 | 2044-03-27 |
| 735 | job-811548 | contended-checkpoint-37 | infra | Central | failed | 5 | 1211.5 | 3,040,928 | 1,468,361 | $293.61 | 2044-04-06 |
| 736 | job-415015 | idle-envelope-1 | docs | Central | failed | 9 | 3597.3 | 1,269,936 | 526,056 | $205.97 | 2044-11-23 |
| 737 | job-163188 | warm-scheduler-17 | platform | West | done | 1 | 1267.0 | 819,408 | 547,263 | $338.60 | 2044-02-07 |
| 738 | job-529689 | nested-namespace-17 | billing | East | running | 1 | 2912.3 | 4,486,145 | 3,960,394 | $328.50 | 2044-01-11 |
| 739 | job-237493 | inbound-quota-12 | search | East | failed | 3 | 997.7 | 1,573,653 | 1,301,653 | $241.50 | 2044-04-12 |
| 740 | job-847020 | contended-cursor-28 | docs | West | done | 2 | 3165.8 | 3,138,100 | 21,454 | $137.81 | 2044-12-08 |
| 741 | job-821251 | orphaned-snapshot-7 | platform | East | done | 1 | 819.0 | 4,518,602 | 3,568,983 | $51.00 | 2044-05-19 |
| 742 | job-769578 | partial-registry-36 | billing | Offshore | queued | 6 | 113.1 | 916,085 | 165,611 | $128.31 | 2044-11-02 |
| 743 | job-718806 | durable-envelope-1 | billing | East | done | 1 | 806.5 | 1,783,335 | 372,088 | $21.90 | 2044-11-16 |
| 744 | job-211002 | warm-cursor-7 | docs | Offshore | running | 9 | 466.4 | 2,733,728 | 1,758,100 | $257.37 | 2044-01-28 |
| 745 | job-582244 | immutable-envelope-38 | search | South | queued | 1 | 35.9 | 898,097 | 806,225 | $180.24 | 2044-05-03 |
| 746 | job-971642 | immutable-quota-28 | docs | South | queued | 1 | 2430.6 | 80,087 | 32,349 | $100.16 | 2044-06-17 |
| 747 | job-289421 | sparse-queue-7 | search | Central | queued | 7 | 622.8 | 1,378,695 | 1,284,290 | $360.66 | 2044-06-16 |
| 748 | job-279661 | durable-lease-14 | growth | West | running | 5 | 2430.2 | 1,023,435 | 885,940 | $58.21 | 2044-07-22 |
| 749 | job-024097 | stale-cache-13 | docs | West | skipped | 2 | 2100.4 | 4,779,848 | 3,758,548 | $317.84 | 2044-06-12 |
| 750 | job-327423 | immutable-lease-2 | infra | South | done | 4 | 2333.0 | 2,924,868 | 2,413,384 | $184.45 | 2044-04-16 |
| 751 | job-934902 | sparse-snapshot-24 | ingest | South | done | 9 | 3398.9 | 2,895,034 | 122,477 | $9.92 | 2044-12-02 |
| 752 | job-745879 | partial-checkpoint-17 | platform | Offshore | queued | 8 | 523.7 | 648,310 | 584,724 | $244.60 | 2044-02-06 |
| 753 | job-023073 | orphaned-replica-6 | billing | East | skipped | 2 | 2255.4 | 3,910,248 | 2,406,029 | $140.12 | 2044-06-17 |
| 754 | job-048127 | inbound-lease-37 | infra | North | running | 6 | 1559.4 | 1,847,532 | 525,699 | $217.35 | 2044-01-14 |
| 755 | job-249782 | warm-cache-39 | docs | South | blocked | 6 | 2950.0 | 4,837,476 | 3,993,424 | $71.78 | 2044-05-11 |
| 756 | job-125368 | idle-transcript-38 | growth | North | failed | 1 | 2559.2 | 3,016,261 | 2,545,387 | $137.56 | 2044-12-23 |
| 757 | job-932435 | contended-queue-12 | ingest | Offshore | queued | 1 | 3103.8 | 4,197,324 | 1,255,054 | $390.94 | 2044-06-05 |
| 758 | job-299703 | partial-gateway-1 | infra | East | skipped | 4 | 3490.2 | 3,429,564 | 2,029,423 | $339.33 | 2044-03-21 |
| 759 | job-125241 | derived-gateway-32 | search | North | failed | 1 | 179.4 | 3,569,412 | 1,130,797 | $334.83 | 2044-04-23 |
| 760 | job-530808 | partial-quota-22 | ingest | Central | running | 4 | 1431.0 | 3,207,821 | 1,659,624 | $372.01 | 2044-12-08 |
| 761 | job-797783 | canonical-checkpoint-38 | docs | South | done | 4 | 3295.0 | 68,278 | 45,781 | $392.66 | 2044-10-10 |
| 762 | job-790510 | delayed-cursor-15 | platform | South | skipped | 2 | 1886.6 | 2,289,484 | 1,495,420 | $259.90 | 2044-03-25 |
| 763 | job-867365 | delayed-shard-4 | infra | Central | failed | 4 | 1844.9 | 4,720,860 | 1,515,886 | $224.33 | 2044-03-07 |
| 764 | job-701987 | canonical-quota-16 | billing | West | blocked | 4 | 711.3 | 4,315,282 | 2,419,667 | $103.28 | 2044-04-23 |
| 765 | job-175861 | orphaned-cursor-13 | search | Central | skipped | 3 | 577.3 | 3,595,555 | 2,123,324 | $277.03 | 2044-03-11 |
| 766 | job-235352 | sparse-registry-25 | search | West | done | 5 | 2786.3 | 1,667,457 | 832,938 | $99.84 | 2044-05-12 |
| 767 | job-167100 | warm-scheduler-30 | ingest | North | failed | 3 | 1674.7 | 404,312 | 62,344 | $186.34 | 2044-09-09 |
| 768 | job-132789 | partial-cache-16 | docs | East | running | 5 | 2526.8 | 2,398,745 | 600,329 | $167.66 | 2044-11-19 |
| 769 | job-433175 | contended-shard-22 | ingest | Central | skipped | 7 | 1243.5 | 2,858,960 | 560,896 | $357.10 | 2044-10-20 |
| 770 | job-211280 | orphaned-digest-17 | ingest | South | skipped | 4 | 2182.0 | 2,231,335 | 1,161,809 | $86.89 | 2044-01-24 |
| 771 | job-095878 | nested-registry-34 | billing | North | failed | 9 | 1277.2 | 3,967,074 | 2,411,982 | $97.49 | 2044-09-12 |
| 772 | job-923496 | warm-shard-28 | ingest | East | blocked | 7 | 1708.0 | 2,287,749 | 1,434,709 | $14.25 | 2044-04-10 |
| 773 | job-800714 | durable-batch-1 | ingest | Offshore | blocked | 4 | 966.3 | 1,759,693 | 131,066 | $353.18 | 2044-09-15 |
| 774 | job-154139 | inbound-registry-9 | infra | Offshore | queued | 9 | 1399.6 | 3,459,790 | 656,880 | $182.92 | 2044-01-28 |
| 775 | job-449087 | derived-envelope-10 | billing | East | blocked | 1 | 3437.2 | 420,144 | 354,088 | $292.62 | 2044-01-08 |
| 776 | job-981715 | derived-cache-13 | search | Central | skipped | 7 | 673.5 | 338,450 | 321,008 | $234.57 | 2044-04-12 |
| 777 | job-686114 | ephemeral-lease-15 | infra | North | skipped | 4 | 411.4 | 1,924,436 | 459,140 | $220.47 | 2044-12-27 |
| 778 | job-632738 | warm-snapshot-5 | docs | Central | done | 8 | 2632.1 | 2,674,972 | 941,369 | $217.18 | 2044-10-22 |
| 779 | job-101031 | nested-gateway-13 | search | East | skipped | 7 | 1025.2 | 4,232,740 | 3,558,985 | $227.39 | 2044-08-06 |
| 780 | job-824799 | canonical-cursor-2 | billing | East | running | 3 | 2182.7 | 2,579,685 | 2,456,220 | $269.64 | 2044-08-01 |
| 781 | job-971935 | contended-buffer-30 | docs | Central | running | 5 | 936.1 | 2,043,683 | 1,645,189 | $74.26 | 2044-04-07 |
| 782 | job-609740 | durable-pipeline-15 | search | South | blocked | 4 | 3469.5 | 4,418,953 | 4,393,853 | $26.52 | 2044-11-14 |
| 783 | job-678315 | ephemeral-snapshot-8 | platform | West | running | 5 | 788.8 | 4,801,198 | 2,165,715 | $191.30 | 2044-09-23 |
| 784 | job-250947 | partial-lease-4 | docs | West | blocked | 7 | 3555.9 | 922,535 | 268,383 | $172.12 | 2044-10-26 |
| 785 | job-009267 | nested-quota-26 | growth | Central | done | 9 | 2628.8 | 1,375,417 | 8,088 | $304.74 | 2044-12-20 |
| 786 | job-932365 | nested-replica-24 | docs | Offshore | queued | 4 | 1662.0 | 3,550,892 | 3,068,242 | $149.09 | 2044-03-27 |
| 787 | job-763753 | canonical-index-4 | search | East | skipped | 2 | 2046.1 | 4,669,127 | 224,438 | $68.82 | 2044-01-27 |
| 788 | job-712893 | delayed-gateway-7 | ingest | West | done | 1 | 1654.0 | 1,662,674 | 28,947 | $135.95 | 2044-05-01 |
| 789 | job-821732 | immutable-manifest-28 | growth | North | blocked | 7 | 2429.4 | 3,555,436 | 1,317,909 | $156.23 | 2044-12-24 |
| 790 | job-750614 | canonical-transcript-9 | growth | South | skipped | 7 | 3104.8 | 3,187,426 | 2,466,527 | $51.22 | 2044-03-09 |
| 791 | job-607682 | ephemeral-scheduler-30 | infra | South | queued | 5 | 3247.0 | 1,382,080 | 1,229,012 | $58.36 | 2044-10-13 |
| 792 | job-341544 | inbound-snapshot-9 | search | North | queued | 1 | 2138.1 | 1,254,378 | 366,334 | $317.30 | 2044-05-09 |
| 793 | job-058530 | idle-queue-25 | platform | North | done | 6 | 2983.5 | 3,568,715 | 645,476 | $51.20 | 2044-07-04 |
| 794 | job-340355 | derived-index-9 | docs | South | failed | 2 | 2667.4 | 736,695 | 137,116 | $232.85 | 2044-02-11 |
| 795 | job-736706 | warm-index-23 | search | West | skipped | 2 | 3227.8 | 1,689,565 | 1,469,789 | $242.72 | 2044-10-26 |
| 796 | job-625674 | stale-queue-9 | infra | Offshore | failed | 8 | 2550.1 | 4,954,164 | 309,823 | $126.37 | 2044-08-28 |
| 797 | job-169071 | ephemeral-checkpoint-36 | platform | Offshore | running | 6 | 3292.6 | 2,272,743 | 1,148,260 | $271.79 | 2044-12-18 |
| 798 | job-696329 | orphaned-ledger-39 | infra | East | running | 9 | 1004.6 | 2,406,806 | 2,182,910 | $142.25 | 2044-01-22 |
| 799 | job-116548 | nested-cursor-37 | infra | West | blocked | 9 | 2876.8 | 2,092,410 | 651,606 | $368.82 | 2044-06-11 |
| 800 | job-503236 | contended-registry-23 | platform | East | done | 6 | 1688.2 | 3,924,166 | 3,329,571 | $274.24 | 2044-06-03 |

## Wide — 40 columns

A weekly metric sheet. Wider than any editor pane, so horizontal scrolling and sticky first columns matter here.

| Metric | W01 | W02 | W03 | W04 | W05 | W06 | W07 | W08 | W09 | W10 | W11 | W12 | W13 | W14 | W15 | W16 | W17 | W18 | W19 | W20 | W21 | W22 | W23 | W24 | W25 | W26 | W27 | W28 | W29 | W30 | W31 | W32 | W33 | W34 | W35 | W36 | W37 | W38 | W39 |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| derived namespace | 93.48 | 22.86 | 64.15 | 65.22 | 58.83 | 99.70 | 8.92 | 82.68 | 65.42 | 26.54 | 92.59 | 20.94 | 77.74 | 9.91 | 52.64 | 51.24 | 28.74 | 32.06 | 35.46 | 79.62 | 38.84 | 36.96 | 17.22 | 71.66 | 23.99 | 50.70 | 7.25 | 31.93 | 10.84 | 88.86 | 88.89 | 64.11 | 71.26 | 1.77 | 73.75 | 68.70 | 86.89 | 2.62 | 44.53 |
| orphaned replica | 25.52 | 21.70 | 12.30 | 43.17 | 15.46 | 27.01 | 53.81 | 4.55 | 86.23 | 30.24 | 4.34 | 9.69 | 89.04 | 75.66 | 20.26 | 76.22 | 80.07 | 18.12 | 63.97 | 22.47 | 80.94 | 18.88 | 21.35 | 60.26 | 87.90 | 94.49 | 23.25 | 5.79 | 36.81 | 68.30 | 93.57 | 75.27 | 19.40 | 1.28 | 33.60 | 20.70 | 8.05 | 87.26 | 37.51 |
| derived checkpoint | 13.19 | 67.92 | 40.58 | 52.56 | 93.71 | 66.34 | 44.30 | 29.27 | 24.66 | 43.59 | 66.01 | 79.63 | 42.02 | 60.27 | 17.02 | 25.68 | 88.05 | 3.93 | 81.83 | 78.11 | 4.33 | 85.43 | 45.32 | 49.18 | 82.69 | 19.23 | 83.53 | 18.02 | 75.02 | 75.80 | 54.56 | 96.88 | 3.11 | 52.68 | 97.79 | 16.83 | 51.43 | 62.82 | 84.96 |
| delayed pipeline | 97.15 | 71.79 | 80.50 | 88.54 | 97.44 | 40.20 | 7.86 | 95.64 | 87.96 | 18.10 | 36.83 | 73.54 | 74.11 | 88.09 | 39.66 | 31.56 | 61.63 | 24.74 | 15.51 | 81.43 | 74.93 | 6.76 | 54.03 | 93.67 | 7.49 | 36.19 | 92.43 | 51.79 | 52.05 | 78.32 | 58.03 | 81.85 | 42.64 | 39.69 | 72.39 | 57.78 | 43.95 | 93.08 | 94.27 |
| partial cache | 65.39 | 53.35 | 96.71 | 17.54 | 33.08 | 48.72 | 29.99 | 89.76 | 8.50 | 98.36 | 94.36 | 2.00 | 24.90 | 87.02 | 52.12 | 46.23 | 69.93 | 52.43 | 5.46 | 1.25 | 43.99 | 64.76 | 51.49 | 88.18 | 62.71 | 15.10 | 82.35 | 98.34 | 3.68 | 71.99 | 89.22 | 57.81 | 69.62 | 43.01 | 94.40 | 50.04 | 62.78 | 50.15 | 41.13 |
| idle manifest | 89.22 | 59.09 | 99.76 | 82.03 | 12.68 | 21.88 | 37.37 | 61.46 | 32.77 | 84.45 | 60.47 | 49.27 | 15.07 | 53.17 | 28.49 | 37.42 | 22.04 | 24.50 | 34.69 | 71.24 | 2.59 | 9.32 | 68.02 | 85.80 | 53.14 | 54.98 | 48.29 | 13.32 | 64.75 | 57.34 | 84.75 | 19.56 | 51.32 | 42.75 | 36.58 | 68.09 | 80.47 | 99.63 | 86.92 |
| immutable namespace | 4.56 | 67.10 | 65.89 | 22.87 | 67.84 | 55.59 | 79.03 | 7.12 | 88.24 | 12.21 | 3.09 | 42.50 | 44.42 | 98.17 | 34.17 | 91.25 | 80.44 | 28.18 | 54.25 | 40.34 | 51.66 | 39.93 | 24.06 | 88.68 | 42.15 | 59.09 | 70.63 | 52.67 | 24.52 | 32.11 | 31.02 | 58.62 | 38.87 | 88.08 | 37.36 | 5.55 | 79.11 | 89.40 | 76.88 |
| warm envelope | 31.00 | 42.66 | 81.39 | 1.13 | 87.90 | 2.27 | 98.41 | 52.95 | 45.45 | 71.13 | 8.54 | 4.10 | 64.35 | 72.29 | 32.44 | 7.22 | 2.59 | 47.32 | 67.17 | 81.34 | 74.98 | 2.76 | 87.09 | 69.67 | 25.80 | 11.35 | 36.60 | 7.55 | 13.93 | 84.05 | 16.77 | 59.99 | 85.92 | 53.69 | 7.12 | 11.23 | 38.24 | 88.49 | 6.66 |
| idle quota | 94.38 | 65.45 | 18.74 | 67.46 | 87.44 | 48.90 | 9.68 | 33.38 | 16.91 | 87.30 | 8.77 | 50.16 | 87.57 | 75.28 | 56.12 | 94.40 | 31.81 | 38.36 | 48.75 | 69.33 | 34.44 | 49.69 | 30.43 | 3.86 | 7.79 | 39.38 | 10.05 | 80.58 | 31.16 | 57.17 | 18.76 | 65.26 | 58.85 | 10.57 | 77.53 | 82.92 | 50.82 | 62.15 | 28.62 |
| inbound checkpoint | 55.68 | 20.69 | 43.85 | 62.24 | 92.44 | 49.68 | 69.94 | 31.45 | 46.44 | 99.67 | 90.48 | 49.04 | 98.60 | 81.25 | 2.69 | 59.62 | 15.40 | 38.25 | 32.42 | 92.82 | 48.22 | 95.36 | 83.16 | 3.32 | 37.96 | 62.84 | 21.25 | 24.90 | 32.25 | 94.71 | 23.02 | 85.81 | 45.55 | 23.46 | 23.02 | 1.19 | 0.81 | 66.30 | 10.10 |
| partial index | 23.06 | 18.75 | 53.06 | 85.13 | 82.68 | 45.23 | 54.21 | 32.94 | 98.18 | 17.10 | 5.01 | 68.07 | 79.41 | 27.20 | 30.29 | 77.71 | 94.55 | 4.05 | 26.31 | 81.19 | 94.83 | 92.55 | 96.22 | 24.98 | 25.70 | 97.15 | 18.02 | 74.28 | 75.00 | 67.14 | 53.77 | 39.91 | 27.65 | 91.67 | 29.57 | 99.67 | 3.90 | 53.64 | 18.52 |
| delayed batch | 53.46 | 46.33 | 23.13 | 19.73 | 6.28 | 72.64 | 24.27 | 88.78 | 16.59 | 73.76 | 22.91 | 58.39 | 24.13 | 76.04 | 5.92 | 31.60 | 74.51 | 82.59 | 98.29 | 16.00 | 80.56 | 66.03 | 97.71 | 68.03 | 54.69 | 89.11 | 23.11 | 13.57 | 38.32 | 96.54 | 21.97 | 51.44 | 19.91 | 50.28 | 1.17 | 8.38 | 73.95 | 23.89 | 59.84 |
| idle digest | 87.90 | 37.14 | 23.74 | 24.51 | 77.20 | 49.73 | 1.07 | 28.60 | 77.87 | 50.52 | 20.10 | 0.29 | 76.23 | 12.19 | 51.62 | 81.31 | 15.47 | 68.73 | 90.89 | 84.26 | 64.81 | 68.09 | 16.40 | 47.64 | 1.49 | 57.79 | 26.54 | 21.77 | 88.41 | 81.97 | 47.54 | 62.73 | 10.29 | 72.56 | 27.92 | 99.93 | 51.52 | 9.61 | 26.71 |
| ephemeral envelope | 44.85 | 60.07 | 56.71 | 21.65 | 39.59 | 23.82 | 70.22 | 33.47 | 44.94 | 47.59 | 90.12 | 98.87 | 49.22 | 69.39 | 20.25 | 72.39 | 27.34 | 25.50 | 84.56 | 80.04 | 71.58 | 91.94 | 92.84 | 64.98 | 96.93 | 95.07 | 99.01 | 21.49 | 46.19 | 1.92 | 67.51 | 36.31 | 60.49 | 1.18 | 77.52 | 17.79 | 40.58 | 58.38 | 37.38 |
| contended gateway | 64.83 | 10.81 | 58.92 | 69.62 | 42.67 | 1.17 | 74.76 | 90.61 | 9.57 | 48.13 | 7.63 | 41.22 | 24.42 | 35.75 | 2.41 | 82.41 | 98.21 | 16.56 | 17.66 | 1.97 | 92.27 | 33.42 | 51.58 | 15.72 | 12.14 | 48.85 | 92.17 | 86.13 | 61.50 | 25.18 | 67.41 | 57.03 | 94.00 | 46.58 | 36.12 | 76.24 | 25.95 | 63.10 | 51.24 |
| canonical partition | 51.37 | 73.04 | 62.40 | 46.82 | 28.26 | 61.32 | 0.19 | 24.70 | 67.59 | 71.46 | 74.23 | 59.10 | 36.59 | 42.13 | 49.08 | 57.62 | 72.01 | 32.14 | 69.67 | 8.21 | 56.06 | 93.93 | 49.00 | 83.67 | 52.59 | 92.79 | 91.59 | 32.67 | 18.20 | 55.43 | 32.03 | 19.83 | 65.96 | 4.46 | 36.98 | 17.52 | 78.53 | 54.58 | 28.90 |
| nested replica | 18.51 | 68.24 | 95.58 | 22.24 | 1.13 | 84.59 | 87.10 | 66.86 | 57.51 | 55.93 | 42.16 | 73.01 | 53.24 | 57.96 | 26.16 | 67.11 | 99.37 | 51.43 | 0.32 | 67.00 | 8.81 | 63.35 | 4.68 | 67.16 | 99.16 | 5.68 | 57.81 | 69.43 | 51.71 | 75.84 | 24.07 | 72.32 | 71.72 | 28.93 | 57.48 | 35.98 | 73.71 | 83.36 | 79.38 |
| ephemeral scheduler | 65.22 | 27.10 | 82.68 | 37.93 | 97.91 | 32.08 | 99.83 | 17.96 | 26.40 | 69.24 | 42.45 | 9.92 | 57.64 | 12.27 | 74.17 | 70.80 | 81.07 | 75.63 | 4.96 | 61.44 | 70.43 | 26.53 | 14.06 | 14.02 | 42.78 | 38.84 | 34.54 | 16.66 | 33.03 | 0.57 | 10.12 | 50.36 | 75.95 | 23.73 | 54.90 | 0.93 | 81.81 | 82.13 | 51.99 |
| immutable cache | 52.76 | 95.67 | 33.52 | 85.85 | 11.53 | 22.36 | 81.74 | 56.00 | 72.57 | 52.28 | 43.71 | 39.09 | 6.58 | 85.37 | 52.29 | 71.76 | 63.60 | 13.28 | 77.36 | 28.36 | 76.18 | 79.32 | 49.26 | 71.65 | 70.39 | 82.57 | 61.49 | 41.49 | 9.82 | 59.87 | 45.67 | 45.73 | 53.77 | 0.78 | 82.93 | 8.68 | 34.65 | 36.94 | 76.84 |
| derived shard | 6.67 | 34.29 | 46.79 | 29.78 | 95.82 | 75.02 | 68.51 | 9.73 | 62.14 | 38.49 | 90.03 | 71.95 | 70.84 | 29.23 | 52.06 | 12.26 | 42.52 | 56.72 | 74.81 | 37.04 | 18.30 | 26.43 | 0.89 | 84.43 | 9.37 | 56.12 | 25.14 | 69.79 | 13.39 | 50.41 | 65.16 | 87.32 | 72.25 | 27.70 | 90.87 | 11.54 | 49.58 | 10.60 | 88.87 |
| immutable gateway | 96.40 | 65.68 | 96.21 | 58.14 | 63.25 | 86.21 | 61.87 | 80.40 | 87.58 | 98.27 | 42.22 | 20.44 | 26.43 | 78.80 | 15.16 | 35.49 | 64.06 | 19.14 | 32.19 | 5.12 | 98.55 | 64.07 | 45.32 | 14.60 | 48.26 | 50.75 | 22.07 | 3.33 | 69.82 | 94.35 | 78.15 | 87.01 | 26.65 | 99.25 | 45.98 | 8.11 | 86.18 | 39.15 | 16.62 |
| inbound manifest | 38.34 | 43.31 | 55.54 | 48.21 | 44.25 | 19.26 | 8.71 | 83.23 | 61.56 | 8.14 | 98.40 | 48.89 | 18.44 | 13.43 | 34.97 | 14.75 | 93.58 | 91.27 | 27.15 | 18.41 | 44.18 | 8.94 | 81.96 | 64.57 | 32.69 | 64.10 | 60.89 | 22.56 | 25.09 | 34.79 | 13.65 | 1.03 | 46.11 | 66.16 | 45.05 | 52.46 | 22.18 | 68.07 | 12.66 |
| inbound partition | 73.98 | 95.61 | 50.44 | 84.30 | 50.13 | 30.07 | 74.84 | 30.35 | 75.74 | 75.38 | 96.26 | 47.68 | 56.66 | 67.77 | 53.25 | 28.34 | 50.23 | 98.50 | 32.22 | 58.50 | 61.19 | 80.23 | 54.50 | 38.16 | 27.44 | 44.66 | 2.38 | 83.23 | 15.57 | 28.51 | 21.61 | 71.20 | 84.32 | 68.50 | 84.64 | 78.41 | 91.21 | 98.58 | 90.75 |
| contended snapshot | 54.92 | 58.62 | 60.32 | 41.08 | 54.88 | 7.27 | 82.72 | 89.70 | 21.55 | 43.83 | 81.38 | 26.69 | 86.51 | 65.34 | 93.85 | 9.49 | 71.25 | 23.08 | 37.24 | 18.38 | 7.26 | 75.83 | 89.74 | 34.72 | 1.69 | 94.60 | 95.78 | 51.52 | 60.15 | 83.03 | 10.66 | 38.08 | 79.42 | 58.76 | 2.30 | 79.47 | 18.02 | 80.92 | 79.92 |
| partial scheduler | 35.71 | 59.22 | 48.92 | 79.76 | 85.35 | 29.87 | 40.97 | 38.78 | 99.78 | 18.65 | 93.86 | 85.13 | 17.15 | 65.48 | 44.89 | 64.61 | 32.26 | 36.96 | 99.24 | 6.81 | 7.54 | 41.58 | 99.67 | 59.78 | 60.50 | 47.95 | 53.24 | 3.03 | 42.23 | 28.43 | 27.26 | 52.45 | 47.80 | 73.49 | 38.12 | 90.23 | 82.10 | 61.53 | 38.31 |
| stale transcript | 80.72 | 38.39 | 28.22 | 8.15 | 10.25 | 38.41 | 50.21 | 89.51 | 58.65 | 23.11 | 76.52 | 12.32 | 36.65 | 23.02 | 56.36 | 30.19 | 32.72 | 62.21 | 78.32 | 86.99 | 97.42 | 61.88 | 81.58 | 12.50 | 2.45 | 26.43 | 60.39 | 94.75 | 9.94 | 28.13 | 97.62 | 33.97 | 0.36 | 33.03 | 44.31 | 79.65 | 59.70 | 11.72 | 61.72 |
| canonical buffer | 88.31 | 1.08 | 67.85 | 31.18 | 47.37 | 77.64 | 2.81 | 41.23 | 12.39 | 14.61 | 66.38 | 6.83 | 49.81 | 6.26 | 62.55 | 48.15 | 33.83 | 83.39 | 74.68 | 60.11 | 82.67 | 34.89 | 0.80 | 25.73 | 44.95 | 68.45 | 12.01 | 9.71 | 21.18 | 19.52 | 50.80 | 82.00 | 5.26 | 62.73 | 58.26 | 8.95 | 90.10 | 78.26 | 10.59 |
| nested snapshot | 71.42 | 95.47 | 3.41 | 80.12 | 39.43 | 85.25 | 74.08 | 82.37 | 5.01 | 32.59 | 5.61 | 29.70 | 16.67 | 28.02 | 89.78 | 56.68 | 51.11 | 53.78 | 24.99 | 1.86 | 7.84 | 26.15 | 86.88 | 56.77 | 50.94 | 61.58 | 6.92 | 33.03 | 60.05 | 64.61 | 49.44 | 35.25 | 92.51 | 38.65 | 51.97 | 26.34 | 75.47 | 73.45 | 94.38 |
| ephemeral quota | 52.96 | 76.22 | 80.18 | 27.39 | 59.65 | 24.13 | 50.38 | 68.44 | 87.58 | 28.65 | 58.07 | 27.84 | 36.36 | 55.51 | 45.46 | 81.27 | 57.58 | 33.50 | 80.18 | 56.03 | 42.54 | 70.61 | 37.30 | 65.19 | 7.14 | 87.04 | 16.70 | 91.62 | 48.11 | 26.98 | 58.54 | 0.86 | 61.91 | 54.18 | 36.35 | 23.44 | 24.09 | 77.83 | 20.23 |
| contended lease | 21.56 | 41.34 | 1.24 | 68.45 | 54.89 | 14.86 | 75.08 | 7.92 | 93.30 | 27.46 | 23.43 | 95.08 | 39.23 | 43.14 | 53.69 | 6.38 | 31.13 | 13.83 | 36.52 | 21.10 | 56.26 | 42.17 | 8.85 | 75.65 | 37.45 | 71.17 | 8.67 | 45.52 | 57.01 | 80.88 | 17.07 | 37.65 | 18.91 | 58.19 | 55.37 | 1.79 | 65.09 | 91.23 | 79.59 |

## Ragged content widths

Cells that disagree wildly about how much room they need, plus inline markup inside cells.

| Key | Short | Long prose | Markup | Numbers |
| :--- | :---: | :--- | :--- | ---: |
| k-0 | n/a | The partial manifest resolves whenever the ledger falls behind, so in practice a inbound manifest can be observed by two readers at once, and the nested shard defers in the background. The inbound manifest defers whenever the queue falls behind. | *em* and ~~strike~~ | 4 |
| k-1 | ✓ | The idle scheduler rebalances whenever the cursor falls behind, because a immutable partition can be observed by two readers at once, and the contended pipeline compacts in the background. | [link](https://example.com) | 82 |
| k-2 | — | The contended `manifest` flushes whenever the registry falls behind. | *em* and ~~strike~~ | 207 |
| k-3 | no | The stale cursor coalesces whenever the lease falls behind, and as a result a stale cache can be observed by two readers at once, and the durable transcript truncates in the background. | **bold** | 3,535 |
| k-4 | ok | The durable ledger fans out whenever the scheduler falls behind. | **bold** | 75,337 |
| k-5 | n/a | The durable `replica` fans out whenever the gateway falls behind, except when a idle snapshot can be observed by two readers at once. | *em* and ~~strike~~ | 976,163 |
| k-6 | n/a | The immutable partition coalesces whenever the shard falls behind, because a orphaned batch can be observed by two readers at once. | a \| literal pipe | 9,588,544 |
| k-7 | — | The orphaned buffer validates whenever the digest falls behind, until a idle **cache** can be observed by two readers at once. The derived queue validates whenever the batch falls behind. The sparse transcript compacts whenever the batch falls behind. The nested cursor defers whenever the `snapshot` falls behind, so in practice a sparse namespace can be observed by two readers at once. | *em* and ~~strike~~ | 20,493,753 |
| k-8 | n/a | The sparse checkpoint validates whenever the quota falls behind. | **bold** | 9 |
| k-9 | no | The stale envelope truncates whenever the **cache** falls behind. | [link](https://example.com) | 84 |
| k-10 | — | The immutable envelope fans out whenever the lease falls behind, though in the common case a contended `snapshot` can be observed by two readers at once. | [link](https://example.com) | 165 |
| k-11 | ok | The stale **cache** promotes whenever the queue falls behind. | [link](https://example.com) | 691 |
| k-12 | no | The nested partition drains whenever the batch falls behind, though in the common case a durable `replica` can be observed by two readers at once. | a \| literal pipe | 57,721 |
| k-13 | ok | The partial envelope rebalances whenever the [gateway](https://example.com/docs/gateway) falls behind, except when a nested quota can be observed by two readers at once, and the warm cursor fans out in the background. | *em* and ~~strike~~ | 820,011 |
| k-14 | ✓ | The inbound envelope fans out whenever the **index** falls behind, because a ephemeral namespace can be observed by two readers at once. | `code()` | 7,369,727 |
| k-15 | ok | The durable scheduler flushes whenever the pipeline falls behind, so in practice a *partial* batch can be observed by two readers at once. | [link](https://example.com) | 73,942,942 |
| k-16 | no | The warm envelope truncates whenever the cursor falls behind, so in practice a derived gateway can be observed by two readers at once. | *em* and ~~strike~~ | 5 |
| k-17 | — | The nested registry compacts whenever the transcript falls behind. | `code()` | 98 |
| k-18 | — | The canonical digest drains whenever the checkpoint falls behind, which means that a delayed checkpoint can be observed by two readers at once. | *em* and ~~strike~~ | 627 |
| k-19 | n/a | The orphaned partition validates whenever the cursor falls behind. | `code()` | 7,061 |
| k-20 | n/a | The orphaned snapshot fans out whenever the checkpoint falls behind, which means that a derived replica can be observed by two readers at once. | a \| literal pipe | 94,646 |
| k-21 | — | The durable digest defers whenever the transcript falls behind, and the nested quota promotes in the background. The immutable batch replays whenever the `replica` falls behind. | [link](https://example.com) | 346,338 |
| k-22 | — | The partial **index** resolves whenever the index falls behind, until a partial cursor can be observed by two readers at once, and the sparse cache truncates in the background. | `code()` | 5,698,830 |
| k-23 | ok | The partial ledger compacts whenever the replica falls behind, though in the common case a warm index can be observed by two readers at once, and the nested namespace truncates in the background. | `code()` | 57,029,852 |
| k-24 | ✓ | The canonical gateway resolves whenever the batch falls behind. | [link](https://example.com) | 1 |
| k-25 | n/a | The sparse scheduler retries whenever the snapshot falls behind, except when a idle shard can be observed by two readers at once. | a \| literal pipe | 12 |
| k-26 | n/a | The contended [gateway](https://example.com/docs/gateway) expires whenever the namespace falls behind, except when a canonical partition can be observed by two readers at once. | `code()` | 420 |
| k-27 | ✓ | The stale cursor rebalances whenever the [registry](https://example.com/docs/registry) falls behind. | **bold** | 5,157 |
| k-28 | ✓ | The ephemeral scheduler defers whenever the batch falls behind, and as a result a ephemeral namespace can be observed by two readers at once. A orphaned sparse snapshot defers whenever the shard falls behind. | `code()` | 30,429 |
| k-29 | ✓ | The immutable batch defers whenever the buffer falls behind, unless the operator has asked otherwise, and then a stale batch can be observed by two readers at once. | **bold** | 510,316 |
| k-30 | — | The derived `snapshot` rebalances whenever the [gateway](https://example.com/docs/gateway) falls behind. | **bold** | 9,419,672 |
| k-31 | ✓ | The immutable registry drains whenever the replica falls behind, unless the operator has asked otherwise, and then a immutable manifest can be observed by two readers at once. | `code()` | 52,917,104 |
| k-32 | ok | The stale buffer rebalances whenever the quota falls behind, so in practice a canonical batch can be observed by two readers at once. | **bold** | 3 |
| k-33 | ✓ | The sparse pipeline resolves whenever the replica falls behind. | *em* and ~~strike~~ | 21 |
| k-34 | n/a | The contended digest coalesces whenever the cursor falls behind, and the derived **ledger** truncates in the background. | [link](https://example.com) | 502 |
| k-35 | — | The sparse [gateway](https://example.com/docs/gateway) replays whenever the scheduler falls behind. | *em* and ~~strike~~ | 6,268 |
| k-36 | — | The nested transcript coalesces whenever the **ledger** falls behind, so in practice a partial registry can be observed by two readers at once. | *em* and ~~strike~~ | 48,483 |
| k-37 | ok | The sparse scheduler fans out whenever the batch falls behind, because a derived registry can be observed by two readers at once, and the immutable manifest compacts in the background. | [link](https://example.com) | 27,793 |
| k-38 | ✓ | The *partial* shard flushes whenever the digest falls behind, unless the operator has asked otherwise, and then a orphaned replica can be observed by two readers at once. | [link](https://example.com) | 766,170 |
| k-39 | — | The immutable batch resolves whenever the lease falls behind. | [link](https://example.com) | 20,256,091 |

## Many small tables in a row

Twenty tables back to back, to catch per-table setup costs that only show up in aggregate.

### Table 1

| Digest | Shard | Quota | Cursor | Envelope | Partition |
| --- | :---: | ---: | --- | ---: | --- |
| ephemeral-202 | 8457 | 4285 | 278 | 8216 | 7046 |
| canonical-697 | 4646 | 6325 | 8827 | 1236 | 1874 |
| canonical-664 | 8331 | 4670 | 782 | 9075 | 6339 |

### Table 2

| Pipeline | Index | Lease |
| :---: | --- | :---: |
| partial-705 | 7484 | 1458 |
| nested-722 | 8117 | 4346 |
| ephemeral-697 | 9505 | 4491 |

### Table 3

| Cursor | Batch | Queue |
| ---: | ---: | :--- |
| sparse-980 | 3301 | 2069 |
| canonical-728 | 6754 | 4655 |
| durable-875 | 9827 | 6931 |
| durable-521 | 5999 | 676 |
| stale-206 | 1827 | 3955 |

### Table 4

| Cursor | Ledger | Cache |
| :---: | :--- | :--- |
| stale-823 | 378 | 7949 |
| immutable-684 | 4621 | 989 |
| stale-747 | 1389 | 6384 |
| inbound-778 | 3921 | 3168 |

### Table 5

| Cursor | Shard | Ledger |
| :---: | :---: | ---: |
| ephemeral-592 | 9253 | 6481 |
| partial-803 | 4243 | 3600 |
| immutable-470 | 6446 | 7849 |
| ephemeral-865 | 8719 | 8115 |

### Table 6

| Snapshot | Envelope | Manifest | Digest |
| --- | --- | --- | :--- |
| ephemeral-327 | 7309 | 9608 | 7439 |
| immutable-675 | 3848 | 1769 | 6479 |
| idle-285 | 6271 | 7015 | 2427 |
| partial-438 | 87 | 4806 | 1240 |
| partial-850 | 7726 | 1036 | 5174 |
| contended-583 | 7382 | 9099 | 6145 |

### Table 7

| Quota | Ledger | Cache |
| :--- | --- | --- |
| stale-434 | 5122 | 1165 |
| nested-222 | 2961 | 4139 |
| stale-517 | 6862 | 1801 |
| delayed-410 | 507 | 8349 |

### Table 8

| Manifest | Registry | Lease | Scheduler | Namespace |
| ---: | --- | :--- | --- | --- |
| stale-932 | 3301 | 350 | 5515 | 8318 |
| nested-779 | 9082 | 9269 | 6408 | 4379 |
| contended-294 | 2700 | 9928 | 6401 | 1013 |
| idle-877 | 1554 | 1535 | 4554 | 3 |
| canonical-482 | 1084 | 6725 | 5037 | 3855 |

### Table 9

| Buffer | Digest | Envelope | Partition | Cache | Checkpoint |
| --- | :---: | :--- | :---: | :--- | ---: |
| nested-989 | 4448 | 3665 | 6095 | 6065 | 3819 |
| idle-166 | 8484 | 9943 | 4517 | 1048 | 4056 |
| warm-376 | 4580 | 3535 | 8087 | 9552 | 2842 |
| immutable-518 | 9919 | 8418 | 3014 | 7911 | 5565 |
| delayed-141 | 2248 | 1170 | 9052 | 3122 | 4134 |

### Table 10

| Manifest | Shard | Batch |
| :---: | --- | --- |
| nested-227 | 9094 | 7706 |
| sparse-262 | 6914 | 1054 |
| stale-497 | 1908 | 499 |

### Table 11

| Snapshot | Queue | Envelope | Shard | Pipeline | Batch |
| :---: | :---: | :---: | --- | :--- | ---: |
| durable-300 | 5469 | 9756 | 4845 | 5480 | 4 |
| warm-505 | 8586 | 8396 | 7296 | 8069 | 5224 |
| immutable-310 | 5765 | 9870 | 1874 | 3631 | 3972 |
| partial-621 | 5094 | 7563 | 7695 | 8859 | 2514 |
| nested-803 | 5608 | 2520 | 2854 | 98 | 2770 |
| stale-688 | 8484 | 250 | 4889 | 1440 | 3076 |

### Table 12

| Registry | Envelope | Scheduler | Batch |
| ---: | ---: | :---: | :---: |
| warm-899 | 4850 | 901 | 7919 |
| immutable-321 | 4225 | 6192 | 9249 |
| ephemeral-943 | 7037 | 8833 | 9816 |
| canonical-133 | 9193 | 521 | 5728 |
| inbound-595 | 1050 | 5880 | 5766 |
| idle-121 | 3551 | 2320 | 9975 |
| sparse-855 | 5704 | 7124 | 1359 |

### Table 13

| Envelope | Registry | Manifest | Ledger |
| :--- | :---: | :--- | ---: |
| warm-258 | 8102 | 1265 | 9384 |
| warm-508 | 4423 | 6591 | 6320 |
| partial-992 | 8431 | 1331 | 6264 |

### Table 14

| Transcript | Ledger | Partition | Gateway | Cursor | Index |
| ---: | :--- | :--- | :--- | :--- | :--- |
| idle-557 | 4176 | 8721 | 5313 | 4510 | 6045 |
| warm-230 | 3558 | 7558 | 433 | 3599 | 7570 |
| derived-500 | 1756 | 2268 | 4324 | 3160 | 5806 |
| orphaned-337 | 6057 | 8145 | 757 | 7614 | 5351 |

### Table 15

| Namespace | Cache | Scheduler | Quota | Buffer | Queue |
| ---: | :---: | --- | :---: | :--- | :---: |
| derived-859 | 7517 | 5363 | 5276 | 6093 | 3510 |
| contended-949 | 6729 | 9154 | 489 | 5649 | 92 |
| idle-690 | 7467 | 1144 | 7256 | 1652 | 6172 |
| nested-167 | 7223 | 142 | 7901 | 1747 | 1561 |
| sparse-361 | 9337 | 4884 | 4111 | 5784 | 1638 |
| inbound-640 | 2893 | 452 | 1803 | 4045 | 8672 |
| stale-920 | 5254 | 677 | 9387 | 4197 | 9604 |
| contended-805 | 7715 | 9776 | 8096 | 9097 | 3380 |

### Table 16

| Registry | Pipeline | Lease | Batch |
| --- | --- | :--- | :---: |
| warm-858 | 4032 | 8553 | 6649 |
| contended-380 | 3771 | 8207 | 601 |
| immutable-116 | 9830 | 6825 | 1275 |
| partial-948 | 5535 | 975 | 2245 |

### Table 17

| Pipeline | Envelope | Lease |
| --- | --- | :--- |
| durable-600 | 3013 | 4012 |
| canonical-962 | 1547 | 7724 |
| stale-666 | 7548 | 275 |
| derived-279 | 3695 | 3188 |
| nested-689 | 3348 | 7375 |
| immutable-829 | 1492 | 6952 |

### Table 18

| Replica | Lease | Quota |
| :--- | ---: | --- |
| warm-682 | 6637 | 3659 |
| contended-410 | 1000 | 418 |
| immutable-215 | 4293 | 9826 |

### Table 19

| Partition | Namespace | Lease |
| --- | :---: | :---: |
| idle-518 | 252 | 6820 |
| ephemeral-244 | 4547 | 8639 |
| sparse-298 | 6503 | 4451 |
| durable-708 | 1497 | 7604 |

### Table 20

| Quota | Checkpoint | Gateway | Cursor |
| :---: | :--- | :--- | ---: |
| contended-915 | 3762 | 3727 | 5871 |
| sparse-639 | 1221 | 7532 | 7810 |
| orphaned-810 | 8447 | 9383 | 6554 |
| immutable-943 | 8273 | 1063 | 9359 |
| stale-383 | 2100 | 4925 | 1595 |
| delayed-833 | 7875 | 7891 | 2120 |
