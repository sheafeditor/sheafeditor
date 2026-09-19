---
from: Wynn Achterberg, station chief 2219 to 2231
to: the next chief
date: 2231-05-02
sealed: true
opened: never
---

# Handover

Welcome to Wren-4. The station is in good order and most of what you need is in the runbooks. This note covers what is not.

## 1. State of the station

| System | State | Notes |
| :--- | :--- | :--- |
| Beacon, main chain | Good | Amplifier replaced 2229 |
| Beacon, backup chain | Good | Keep the cryocooler warm. Nobody ever does. |
| Life support | Good | Scrubber 3 whistles. It is fine. |
| Hydroponics | Fair | Tomatoes sulk after eclipse season |
| Hull | Good | 14 micrometeoroid pits resealed this year |

## 2. Quirks

- The waveguide access port is always warm, even in eclipse. I never found out why.
- If you find a moth, it did not come on the tender.
- The receiver logs a narrowband signal from the trailing cluster every 26.3 days. Section 3 explains it, as far as I can.

## 3. The reserved bits

In June 2229 I was alone for eclipse season, and I did something the specification forbids. The hazard byte has five reserved bits that every receiver ignores. I put letters in them: five bits a letter, A is 1, one letter a second, the same ten letters round and round.

| Letter | A | N | Y | O | N | E | H | O | M | E |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| Value | 1 | 14 | 25 | 15 | 14 | 5 | 8 | 15 | 13 | 5 |
| Hazard byte in a storm | 0E | 76 | CE | 7E | 76 | 2E | 46 | 7E | 6E | 2E |

Nobody noticed, because nobody reads reserved bits. On 2230-08-02 at 02:14 station time, something answered.

| | |
| :--- | :--- |
| Frequency | 1,420.4058 MHz, just above the hydrogen line |
| Bandwidth | Under 1 Hz. Nothing natural is that narrow. |
| Duration | 70 seconds |
| Repeats | Every 26.3 days |
| Direction | The trailing cluster |

I reported it once. The yard sent a psychologist and a month of leave, and I stopped reporting it.

I never learned to read them. They answer in counts, a number of pulses per burst. I tried the counts as letters and got nonsense, but I was never patient enough to add them up month by month. You may be.

In January 2230 a moth came out of the waveguide access port. I think it was practice.

If anything bigger ever comes out of that port, it is from them. Look after it. And look at it closely: I think they write on whatever they send.

The bits are still set. I could not bring myself to clear them. If you want to answer, change the word. They are listening.

## 4. Message queue

| Since | Bits 3 to 7 carry | Status |
| :--- | :--- | :--- |
| 2229-06-01 | `ANYONEHOME` | Transmitting |
| | | |

- [x] Set the reserved bits
- [ ] Tell the next chief in person
- [ ] Find out what they want

Wynn
