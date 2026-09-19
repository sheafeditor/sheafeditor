# We deleted the nightly job and nobody noticed

*Published 2044-04-02 · 9 min read · Filed under: engineering, scheduling*

![A ferry terminal at dawn, two berths, one vessel alongside](../assets/terminal-dawn.png)

For six years a cron entry on a machine nobody could name rebuilt our sailing schedules every night at 02:15. It worked, in the sense that schedules existed the next morning. It also produced a different answer roughly one night in six, given identical inputs, and nobody could tell you why.

Last month we deleted it. Here is what we learned, in the order we learned it.

---

## The bug was not in the code

The first thing everyone assumed — including us — was that the generator had a race. It did not. It was single-threaded, synchronous, and about four hundred lines long. We read all of them.

The nondeterminism came in through the door marked *obviously fine*:

```js
const sailings = await db.query('SELECT * FROM sailings WHERE season = $1', [season]);
for (const s of sailings) {
  assignVessel(s);
}
```

No `ORDER BY`. For six years the planner returned rows in whatever order the storage engine felt like, and `assignVessel` is first-fit, so the order determined the assignment. Most nights the physical order was stable. After a vacuum, or a plan change, or enough churn in the table, it was not.

> The code was deterministic. The *input* was not, and nothing in the system distinguished those two things.

That distinction turned out to be the whole project.

## Determinism is a property you have to be able to check

Fixing the query took a minute. Convincing ourselves it was fixed took three weeks, because we had no way to answer "did the schedule change, and why?"

So we built one before we built anything else. Every schedule now carries the hash of the inputs that produced it:

```ts
const id = scheduleId({ timetable, fleet, exceptions });
```

Which sounds like bookkeeping and is actually the feature. Once a schedule names its inputs:

- Publishing an identical schedule is a no-op, so retries stopped being scary.
- "The schedule changed" became a claim you can check rather than argue about.
- The nightly diff email went from 900 lines of noise to, most nights, nothing.

That last one had an effect we did not predict. When the email is usually empty, people read it.

## Shadow mode is worth more than tests

We ran the new planner alongside the old one for eleven days, comparing outputs and logging every divergence. Our test suite had been green the whole time. Shadow mode found three classes of divergence in the first two days:

1. Exceptions applied in file order in one implementation and in ID order in the other. Both were defensible; only one matched what operations expected.
2. A vessel with a minimum turnaround of exactly zero, which the old planner treated as "unset" and the new one treated as zero.
3. Daylight-saving transitions, obviously, because it is always daylight-saving transitions.

None of these were reachable from our fixtures, because our fixtures were written by the same people who wrote the code and shared its blind spots. Production data does not share your blind spots.

## The part that actually made people happier

The schedules got better, marginally. Planning got faster, substantially — p99 went from 190 seconds to 22. Neither is what anyone mentions.

What people mention is that conflicts now appear *while you edit the timetable*, in the editor, next to the line that caused them. Before, you saved your edit, waited for the nightly run, and found out the next morning that two vessels wanted the same berth at 07:20.

<figure>
  <img src="../assets/conflict-inline.png" alt="An editor showing a berth-contention warning inline under a timetable row" width="640">
  <figcaption>The whole payoff, in one screenshot: the warning is next to the cause.</figcaption>
</figure>

The planner is a pure function, so running it on every keystroke costs nothing worth measuring. That was not a goal of the RFC. It fell out of making the thing deterministic, which is the sort of thing that happens when you fix a cause instead of a symptom.

## What we would do differently

- **Delete the old job sooner.** We kept it behind a flag for a full cycle out of caution. Nobody flipped the flag. The flag itself became a small ongoing tax — two code paths, two sets of questions in review.
- **Write down the ordering rule first.** We discovered the sort key by finding places that needed one. Stating it up front would have found them faster.
- **Not build the CSV export.** We built a schedule-diff CSV export because someone asked. It has been downloaded four times, three of them by us.

## The uncomfortable conclusion

The system was not broken in any way our monitoring could see. Uptime was fine. Error rates were fine. The nightly job succeeded every night for six years.

It was broken in a way only a person could see, and only if they were looking at two schedules side by side and remembered what yesterday's looked like. We eventually noticed because a customer told us.

I do not have a tidy lesson about that. The honest version is: some failures do not show up as failures, and the only instrument that finds them is somebody being annoyed enough to look.

---

*Next up: what we are doing about disruptions, where determinism helps much less than you would hope.*

**Related:** [RFC 0148](rfc-0148-scheduling.md) · [Changelog](changelog.md) · [Ferry CLI tutorial](tutorial.md)
