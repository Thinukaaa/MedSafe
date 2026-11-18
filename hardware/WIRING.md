# MedSafe device — wiring

One ESP32 does two jobs: **fridge thermometer** (DS18B20 → reading every 60 s) and **shop status light**
(RGB LED + OLED, summary every 5 min). Sketch: [medsafe_device/medsafe_device.ino](medsafe_device/medsafe_device.ino).

```
                      ESP32 DevKit
                   ┌───────────────┐
   DS18B20 red ────┤ 3V3           │
                   │               │
   4.7 kΩ ─────────┤ 3V3           │      (pull-up: 3V3 ↔ DATA)
     │             │               │
   DS18B20 yellow ─┤ GPIO 4        │
   DS18B20 black ──┤ GND           │
                   │               │
   OLED VCC ───────┤ 3V3           │
   OLED GND ───────┤ GND           │
   OLED SDA ───────┤ GPIO 21       │
   OLED SCL ───────┤ GPIO 22       │
                   │               │
   LED R ─[220 Ω]──┤ GPIO 25       │
   LED G ─[220 Ω]──┤ GPIO 26       │
   LED B ─[220 Ω]──┤ GPIO 27       │
   LED common (−) ─┤ GND           │
                   └───────┬───────┘
                         USB 5 V (phone charger)
```

| Part | Pin | ESP32 |
|---|---|---|
| DS18B20 waterproof probe | VCC (red) | 3V3 |
| | GND (black) | GND |
| | DATA (yellow) | GPIO 4 **+ 4.7 kΩ to 3V3** |
| SSD1306 0.96" I2C OLED (0x3C) | VCC / GND | 3V3 / GND |
| | SDA / SCL | GPIO 21 / GPIO 22 |
| RGB LED, common cathode | R / G / B | GPIO 25 / 26 / 27, each through 220 Ω |
| | common (longest leg) | GND |

**LED:** red = expired stock on the shelf or fridge outside 2–8 °C · amber = critical stock · green = all good · blue = waiting for the first summary.
**OLED:** `Fridge 5.2°C OK` / `Expired 2 · Rs 1,240` / `Critical 5  Warn 12` / `Updated 08:15` (adds `OFFLINE` when it cannot reach the server).

## Parts list

| Part | Qty | Price (Rs) |
|---|---|---|
| ESP32 DevKit v1 (30-pin) | 1 | |
| DS18B20 waterproof temperature probe (1 m) | 1 | |
| SSD1306 0.96" I2C OLED, 128×64 | 1 | |
| RGB LED 5 mm, common cathode | 1 | |
| Resistor 220 Ω | 3 | |
| Resistor 4.7 kΩ | 1 | |
| Breadboard + jumper wires | 1 set | |
| USB cable + 5 V phone charger | 1 | |
| **Total** | | |

## Setup

1. Arduino IDE → Boards Manager → install **esp32 by Espressif**. Board: **ESP32 Dev Module**.
2. Library Manager → install **OneWire**, **DallasTemperature**, **Adafruit SSD1306** (+ Adafruit GFX), **ArduinoJson** (v7).
3. In the sketch set `WIFI_SSID`, `WIFI_PASS`, `API_URL` (your `/exec` URL), `DEVICE_KEY` (same as the Script Property `DEVICE_KEY`) and `DEVICE_ID`.
4. Upload, open Serial Monitor at 115200 baud, and check for `POST temp … ok` and `Summary: …`.
5. Put the probe inside the fridge (cable under the door seal); keep the board outside.

## No parts? Use the Wokwi simulator

**Online (wokwi.com):** New project → ESP32 (Arduino). Replace `sketch.ino` with `medsafe_device.ino`, replace
`diagram.json` with [wokwi/diagram.json](wokwi/diagram.json), add [wokwi/libraries.txt](wokwi/libraries.txt) in the Library Manager tab.
Keep `WIFI_SSID = "Wokwi-GUEST"` and an empty password. Press ▶. Click the DS18B20 to change the temperature
(try 9 °C to see the LED turn red after the next reading).

**VS Code:** install the Wokwi extension, build with
`arduino-cli compile --fqbn esp32:esp32:esp32 --output-dir hardware/wokwi/build hardware/medsafe_device`,
then open `hardware/wokwi` and run *Wokwi: Start Simulator* ([wokwi.toml](wokwi/wokwi.toml)).

> Security note for the demo: the sketch uses `setInsecure()` (no TLS certificate check) to keep setup simple.
> The device key only allows posting temperatures and reading the summary counts.
