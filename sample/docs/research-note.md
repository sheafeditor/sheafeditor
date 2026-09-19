---
title: "Queue depth as a leading indicator of berth contention"
authors:
  - A. Okonkwo
  - M. Lindqvist
affiliation: Institute for Transport Systems
date: 2044-03-09
keywords: [queueing, scheduling, port operations]
---

# Queue depth as a leading indicator of berth contention

**Abstract.** We examine whether the depth of the arrival queue at a two-berth terminal predicts berth contention far enough ahead to be actionable. Using 14 months of AIS-derived arrival data from a fictional North-West corridor, we find that a 20-minute rolling queue depth predicts contention 45 minutes ahead with an AUC of 0.87, and that the predictive signal collapses once scheduled headway falls below 25 minutes. We argue that the collapse is structural rather than a data artefact, and that terminals operating below that headway need a different instrument.

**Keywords:** queueing · scheduling · port operations · leading indicators

---

## 1. Introduction

Berth contention — two vessels wanting one berth at overlapping times — is usually detected when it happens. Operators then absorb it with holding patterns, which propagate delay downstream at roughly 1.6 minutes of downstream delay per minute held.[^propagation] An instrument that flags contention early enough to reschedule rather than hold would be worth having.

[^propagation]: The 1.6 figure is our own estimate over the study corridor, consistent with the 1.4–1.9 range reported for comparable terminals.

The question we ask is narrow: *does queue depth, alone, carry enough signal?* We are not proposing a scheduler. We are asking whether a quantity terminals already measure can be read as a warning.

## 2. Data

Fourteen months of arrivals (2043-01 through 2044-02) at a two-berth terminal, $n = 41{,}882$ vessel arrivals across 6 routes.

| Field | Source | Resolution | Missing |
| :--- | :--- | :--- | ---: |
| Arrival time | AIS | 1 s | 0.2% |
| Berth assignment | Terminal ops log | event | 1.8% |
| Scheduled departure | Published timetable | 1 min | 0.0% |
| Vessel class | Fleet registry | — | 0.0% |
| Weather state | Met service | 10 min | 4.1% |

Rows with a missing berth assignment were dropped rather than imputed; the assignment is the label, and imputing it would manufacture the effect we are testing for.

## 3. Method

Let $q(t)$ be the number of vessels within the approach zone at time $t$, and $\bar{q}_{20}(t)$ its 20-minute rolling mean. We define contention at time $t$ as

$$
C(t) = \mathbb{1}\!\left[\exists\, (a, b) : \text{berth}(a) = \text{berth}(b),\ [s_a, e_a] \cap [s_b, e_b] \neq \emptyset,\ s_a \le t \le e_a \right]
$$

and fit a logistic model predicting $C(t + \Delta)$ from $\bar{q}_{20}(t)$, scheduled headway $h(t)$, and their interaction:

$$
\log \frac{p}{1-p} = \beta_0 + \beta_1 \bar{q}_{20}(t) + \beta_2 h(t) + \beta_3 \bar{q}_{20}(t)\,h(t)
$$

Evaluation is a forward-chaining split — train on months $1..k$, test on month $k+1$ — because a random split leaks the future through the rolling window.

```python
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

def forward_chain(frames, horizon_min=45):
    scores = []
    for k in range(3, len(frames)):
        train = concat(frames[:k])
        test = frames[k]
        model = LogisticRegression(max_iter=2000).fit(
            train[["q20", "headway", "q20_x_headway"]],
            train[f"contention_t{horizon_min}"],
        )
        p = model.predict_proba(test[["q20", "headway", "q20_x_headway"]])[:, 1]
        scores.append(roc_auc_score(test[f"contention_t{horizon_min}"], p))
    return scores
```

## 4. Results

### 4.1 Predictive performance by horizon

| Horizon $\Delta$ | AUC | 95% CI | Precision @ 0.5 | Recall @ 0.5 |
| ---: | ---: | :--- | ---: | ---: |
| 15 min | 0.94 | [0.93, 0.95] | 0.81 | 0.78 |
| 30 min | 0.91 | [0.90, 0.92] | 0.74 | 0.71 |
| 45 min | 0.87 | [0.85, 0.88] | 0.68 | 0.63 |
| 60 min | 0.79 | [0.77, 0.81] | 0.57 | 0.52 |
| 90 min | 0.66 | [0.63, 0.69] | 0.41 | 0.38 |

Performance degrades smoothly with horizon until 60 minutes, then falls off. We take 45 minutes as the operational limit: it is the point where precision is still high enough that acting on the warning is cheaper than absorbing the contention.

### 4.2 The headway floor

Splitting by scheduled headway shows the interaction term earning its place:

| Headway band | $n$ | AUC @ 45 min |
| :--- | ---: | ---: |
| ≥ 40 min | 11,204 | 0.92 |
| 25–40 min | 18,771 | 0.88 |
| 15–25 min | 8,940 | 0.71 |
| < 15 min | 2,967 | 0.58 |

Below 25 minutes of headway, queue depth stops being informative. This is not a sample-size effect — the sub-15-minute band has nearly 3,000 observations, and the confidence interval is tight around 0.58.

> The interpretation we favour is structural: below the terminal's own service time, the queue is always non-empty, so its depth no longer distinguishes a busy period from a contended one. The instrument saturates.

### 4.3 Weather

Adding weather state improves AUC by 0.01 at 45 minutes, which we do not consider meaningful given the 4.1% missingness and the fact that severe weather suppresses arrivals entirely.

## 5. Threats to validity

- **Single terminal.** Two berths and six routes. We make no claim about larger terminals, where berth assignment is itself a scheduling decision.
- **Label noise.** Berth assignment comes from an operations log that is corrected retrospectively; ~1.8% of assignments were edited after the fact.
- **Regime change.** The corridor's timetable changed in 2043-09. Forward chaining means the model trains across that boundary; a per-regime fit gives slightly higher AUC (0.89 at 45 min) on less data.

## 6. Conclusion

Queue depth is a usable 45-minute warning for berth contention at terminals with scheduled headway above 25 minutes, and is not usable below it. The practical recommendation is unglamorous: terminals should check their headway distribution before adopting a queue-depth alarm, because for a meaningful fraction of them the alarm will be noise.

## References

1. Kendall, D. G. (1953). Stochastic processes occurring in the theory of queues. *Ann. Math. Statist.*, 24(3), 338–354.
2. Little, J. D. C. (1961). A proof for the queuing formula $L = \lambda W$. *Operations Research*, 9(3), 383–387.
3. Institute for Transport Systems (2043). *North-West corridor arrival dataset*, v3. Fictional dataset, used here for illustration.
4. Okonkwo, A. (2042). Holding-pattern cost propagation in short-sea shipping. *Working paper 42-11*.
