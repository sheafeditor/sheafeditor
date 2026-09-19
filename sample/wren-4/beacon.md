# Beacon specification

Wren-4 transmits a timing pulse that ships use for position and a slow data channel that carries the belt's hazard bulletin.

## Pulse format

| Field | Bits | Value | Meaning |
| :--- | ---: | :--- | :--- |
| Sync word | 32 | `0x1ACFFC1D` | Start of frame |
| Station ID | 16 | `0x5704` | Wren-4 |
| Epoch | 48 | seconds since 2200-01-01 | Coarse time |
| Sub-second | 32 | 2⁻³² s units | Fine time |
| Hazard flags | 8 | bitfield | See [hazard flags](#hazard-flags) |
| CRC | 16 | CRC-16/CCITT-FALSE | Over every byte after the sync word |

```c
struct wren_pulse {
    uint32_t sync;        /* 0x1ACFFC1D */
    uint16_t station_id;  /* 0x5704 */
    uint64_t epoch : 48;
    uint32_t subsec;
    uint8_t  hazards;     /* bit 0 debris, bit 1 CME, bit 2 blackout */
    uint16_t crc;
} __attribute__((packed));
```

## Hazard flags

| Bit | Mask | Meaning |
| :---: | :---: | :--- |
| 0 | `0x01` | Debris reported within 5 Mm |
| 1 | `0x02` | Coronal mass ejection in progress |
| 2 | `0x04` | Radio blackout expected |
| 3 to 7 | `0xF8` | Reserved. Transmit as zero. |

## Frequency plan

| Channel | Centre | Bandwidth | Power | Use |
| :--- | ---: | ---: | ---: | :--- |
| Timing | 8.450 GHz | 2 MHz | 200 W | Pulse, every 1.000 s |
| Bulletin | 8.455 GHz | 250 kHz | 50 W | Hazard bulletin, 1 kbit/s |
| Backup | 2.290 GHz | 2 MHz | 40 W | Timing only, when the main chain fails |
| Distress | 406.0 MHz | 3 kHz | 5 W | Omnidirectional tone |

## Link budget

A ship can hold lock when the received power clears the receiver's sensitivity with margin. Received power follows the Friis transmission equation:

$$
P_r = P_t \, G_t \, G_r \left( \frac{\lambda}{4 \pi d} \right)^2
$$

In decibels, which is how anyone actually does it:

$$
P_r\,[\mathrm{dBW}] = P_t + G_t + G_r - 20\log_{10}\!\left(\frac{4\pi d}{\lambda}\right) - L_\text{misc}
$$

At $f = 8.45$ GHz, $\lambda \approx 3.55$ cm. The free-space loss at distance $d$ is $L_{fs} = 20\log_{10}(d) + 20\log_{10}(f) - 147.55$ dB with $d$ in metres and $f$ in hertz.

| Term | Quiet sun | During the CME |
| :--- | ---: | ---: |
| Transmit power, 200 W | +23.0 dBW | +23.0 dBW |
| Beacon sector horn gain | +18.0 dBi | +18.0 dBi |
| Ship antenna gain | +10.0 dBi | +10.0 dBi |
| Free-space loss at 38 Mm | −202.6 dB | −202.6 dB |
| Plasma scintillation | −1.0 dB | −14.0 dB |
| Pointing and polarisation | −2.0 dB | −2.0 dB |
| **Received power** | **−154.6 dBW** | **−167.6 dBW** |
| Receiver sensitivity | −160.0 dBW | −160.0 dBW |
| **Margin** | **+5.4 dB** | **−7.6 dB** |

A 7.6 dB shortfall is a factor of about 5.8 in power. Lock range scales with the square root of that, which is why range fell from 38 Mm to under 16 Mm before the controller failed and to zero after it.

```python
from math import log10, pi

def margin_db(p_tx_w, g_tx, g_rx, d_m, f_hz, losses_db, sensitivity_dbw=-160.0):
    fspl = 20 * log10(d_m) + 20 * log10(f_hz) - 147.55
    p_rx = 10 * log10(p_tx_w) + g_tx + g_rx - fspl - losses_db
    return p_rx - sensitivity_dbw

print(round(margin_db(200, 18, 10, 38e6, 8.45e9, 3), 1))   # 5.4
print(round(margin_db(200, 18, 10, 38e6, 8.45e9, 16), 1))  # -7.6
```
