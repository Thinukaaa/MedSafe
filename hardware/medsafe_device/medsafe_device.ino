/*
  MedSafe device — one ESP32, two jobs:
    1) Fridge thermometer: reads a DS18B20 every 60 s and POSTs it to the MedSafe Apps Script (action=temp).
    2) Shop status light: every 5 min GETs action=summary and shows it on an RGB LED + 0.96" OLED.
         LED RED   = expired stock on the shelf OR fridge outside 2–8 °C (WHO vaccine/insulin range)
         LED AMBER = critical stock (expires within the critical window)
         LED GREEN = all good
    Offline: keeps the last summary on screen, buffers up to 60 readings and retries.

  WIRING (ESP32 DevKit v1 / DevKitC, 3.3 V logic)
  ┌──────────────────────────┬──────────────┬───────────────────────────────────────────┐
  │ Part                     │ Part pin     │ ESP32                                     │
  ├──────────────────────────┼──────────────┼───────────────────────────────────────────┤
  │ DS18B20 (waterproof)     │ VCC (red)    │ 3V3                                       │
  │                          │ GND (black)  │ GND                                       │
  │                          │ DATA (yellow)│ GPIO 4  + 4.7 kΩ pull-up from DATA to 3V3 │
  │ SSD1306 0.96" I2C OLED   │ VCC          │ 3V3                                       │
  │                          │ GND          │ GND                                       │
  │                          │ SDA          │ GPIO 21                                   │
  │                          │ SCL          │ GPIO 22                                   │
  │ RGB LED, common cathode  │ R            │ GPIO 25 via 220 Ω                         │
  │                          │ G            │ GPIO 26 via 220 Ω                         │
  │                          │ B            │ GPIO 27 via 220 Ω                         │
  │                          │ common (−)   │ GND                                       │
  └──────────────────────────┴──────────────┴───────────────────────────────────────────┘

  Libraries (Arduino IDE → Library Manager): OneWire, DallasTemperature, Adafruit SSD1306 (+ Adafruit GFX), ArduinoJson (v7).
  Board: "ESP32 Dev Module" (esp32 by Espressif).
  Wokwi simulator: see hardware/wokwi (WiFi "Wokwi-GUEST", no password).
*/

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <ArduinoJson.h>
#include <time.h>

// ---------------- Settings — edit these ----------------
const char* WIFI_SSID  = "Wokwi-GUEST";        // your shop Wi-Fi
const char* WIFI_PASS  = "";
const char* API_URL    = "https://script.google.com/macros/s/PASTE_DEPLOYMENT_ID/exec";
const char* DEVICE_KEY = "PASTE_DEVICE_KEY";   // same as Script Property DEVICE_KEY
const char* DEVICE_ID  = "fridge-1";

const uint32_t READ_EVERY_MS    = 60UL * 1000;       // fridge reading
const uint32_t SUMMARY_EVERY_MS = 5UL * 60 * 1000;   // shop summary
const float    FRIDGE_MIN_C = 2.0, FRIDGE_MAX_C = 8.0;   // WHO vaccine/insulin storage range

// ---------------- Pins ----------------
const int PIN_ONEWIRE = 4;
const int PIN_SDA = 21, PIN_SCL = 22;
const int PIN_R = 25, PIN_G = 26, PIN_B = 27;

OneWire oneWire(PIN_ONEWIRE);
DallasTemperature sensors(&oneWire);
Adafruit_SSD1306 oled(128, 64, &Wire, -1);

// ---------------- State ----------------
struct Reading { uint32_t epoch; float tempC; };
const int QUEUE_MAX = 60;                 // ~1 h of readings kept while offline
Reading queue[QUEUE_MAX];
int qHead = 0, qCount = 0;

float lastTempC = NAN;
bool  haveSummary = false, summaryStale = false;
int   expiredN = 0, criticalN = 0, warningN = 0;
float expiredRs = 0;
String updatedHHMM = "--:--";
uint32_t lastRead = 0, lastSummary = 0;

// ---------------- Helpers ----------------
void setLed(bool r, bool g, bool b) {
  digitalWrite(PIN_R, r ? HIGH : LOW);   // common cathode: HIGH = on
  digitalWrite(PIN_G, g ? HIGH : LOW);
  digitalWrite(PIN_B, b ? HIGH : LOW);
}

bool fridgeOk(float c) { return !isnan(c) && c >= FRIDGE_MIN_C && c <= FRIDGE_MAX_C; }

String rupees(float rs) {              // 1240.4 → "Rs 1,240"
  long v = lround(rs);
  String digits = String(v), out = "";
  int n = digits.length();
  for (int i = 0; i < n; i++) {
    out += digits[i];
    int left = n - 1 - i;
    if (left > 0 && left % 3 == 0) out += ',';
  }
  return "Rs " + out;
}

uint32_t nowEpoch() {
  time_t t = time(nullptr);
  return t > 1700000000 ? (uint32_t)t : 0;   // 0 = clock not synced yet → server uses its own time
}

void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) delay(250);
}

// ---------------- Display + LED ----------------
void showStatus() {
  oled.clearDisplay();
  oled.setTextSize(1);
  oled.setTextColor(SSD1306_WHITE);
  oled.cp437(true);

  // Line 1: "Fridge 5.2°C OK"
  oled.setCursor(0, 0);
  oled.print("Fridge ");
  if (isnan(lastTempC)) oled.print("--.-");
  else oled.print(lastTempC, 1);
  oled.write(248);                     // ° in code page 437
  oled.print("C ");
  oled.print(isnan(lastTempC) ? "SENSOR?" : (lastTempC > FRIDGE_MAX_C ? "WARM" : (lastTempC < FRIDGE_MIN_C ? "COLD" : "OK")));

  // Line 2: "Expired 2 · Rs 1,240"
  oled.setCursor(0, 16);
  oled.print("Expired ");
  oled.print(haveSummary ? String(expiredN) : String("-"));
  oled.print(" ");
  oled.write(250);                     // · in code page 437
  oled.print(" ");
  oled.print(haveSummary ? rupees(expiredRs) : String("Rs -"));

  // Line 3: "Critical 5"
  oled.setCursor(0, 32);
  oled.print("Critical ");
  oled.print(haveSummary ? String(criticalN) : String("-"));
  oled.print("  Warn ");
  oled.print(haveSummary ? String(warningN) : String("-"));

  // Line 4: "Updated 08:15"
  oled.setCursor(0, 48);
  oled.print("Updated ");
  oled.print(updatedHHMM);
  if (summaryStale || WiFi.status() != WL_CONNECTED) oled.print(" OFFLINE");
  oled.display();

  // LED: red > amber > green; blue = waiting for the first summary
  bool fridgeBad = !isnan(lastTempC) && !fridgeOk(lastTempC);
  if (fridgeBad || (haveSummary && expiredN > 0)) setLed(true, false, false);
  else if (haveSummary && criticalN > 0)          setLed(true, true, false);   // amber = red + green
  else if (haveSummary)                           setLed(false, true, false);
  else                                            setLed(false, false, true);
}

// ---------------- Network ----------------
bool postReading(const Reading& r) {
  WiFiClientSecure client;
  client.setInsecure();                 // demo: skip certificate check (Google's cert rotates)
  HTTPClient http;
  http.setFollowRedirects(HTTPC_FORCE_FOLLOW_REDIRECTS);   // Apps Script answers via a 302 redirect
  http.setTimeout(15000);
  if (!http.begin(client, API_URL)) return false;
  http.addHeader("Content-Type", "text/plain;charset=utf-8");
  JsonDocument doc;
  doc["action"] = "temp";
  doc["deviceKey"] = DEVICE_KEY;
  doc["deviceId"] = DEVICE_ID;
  doc["tempC"] = serialized(String(r.tempC, 2));
  if (r.epoch) doc["ts"] = r.epoch;
  String body;
  serializeJson(doc, body);
  int code = http.POST(body);
  String resp = code > 0 ? http.getString() : "";
  http.end();
  bool ok = code == 200 && resp.indexOf("\"ok\":true") >= 0;
  Serial.printf("POST temp %.2f -> %d %s\n", r.tempC, code, ok ? "ok" : resp.c_str());
  return ok;
}

void flushQueue() {
  connectWifi();
  if (WiFi.status() != WL_CONNECTED) return;
  int sent = 0;
  while (qCount > 0 && sent < 10) {               // at most 10 per cycle so the loop stays responsive
    int idx = (qHead - qCount + QUEUE_MAX) % QUEUE_MAX;
    if (!postReading(queue[idx])) break;          // keep it and retry next minute
    qCount--; sent++;
  }
}

void fetchSummary() {
  connectWifi();
  if (WiFi.status() != WL_CONNECTED) { summaryStale = true; return; }
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  http.setFollowRedirects(HTTPC_FORCE_FOLLOW_REDIRECTS);
  http.setTimeout(20000);
  String url = String(API_URL) + "?action=summary&deviceKey=" + DEVICE_KEY;
  if (!http.begin(client, url)) { summaryStale = true; return; }
  int code = http.GET();
  String resp = code > 0 ? http.getString() : "";
  http.end();
  JsonDocument doc;
  if (code != 200 || deserializeJson(doc, resp) || !doc["error"].isNull()) {
    Serial.printf("GET summary -> %d %s\n", code, resp.c_str());
    summaryStale = true;                          // keep showing the last good summary
    return;
  }
  expiredN  = doc["expired"]["n"] | 0;
  expiredRs = doc["expired"]["rs"] | 0.0;
  criticalN = doc["critical"]["n"] | 0;
  warningN  = doc["warning"]["n"] | 0;
  updatedHHMM = String((const char*)(doc["generatedAtLocal"] | "--:--"));
  haveSummary = true;
  summaryStale = false;
  Serial.printf("Summary: expired %d (Rs %.0f), critical %d, warning %d @ %s\n", expiredN, expiredRs, criticalN, warningN, updatedHHMM.c_str());
}

void takeReading() {
  sensors.requestTemperatures();
  float c = sensors.getTempCByIndex(0);
  if (c == DEVICE_DISCONNECTED_C || c < -40 || c > 85) {
    Serial.println("DS18B20 not found — check the 4.7k pull-up on GPIO 4");
    lastTempC = NAN;
    return;
  }
  lastTempC = c;
  queue[qHead] = { nowEpoch(), c };
  qHead = (qHead + 1) % QUEUE_MAX;
  if (qCount < QUEUE_MAX) qCount++;               // when full, the oldest reading is overwritten
}

// ---------------- Arduino ----------------
void setup() {
  Serial.begin(115200);
  pinMode(PIN_R, OUTPUT); pinMode(PIN_G, OUTPUT); pinMode(PIN_B, OUTPUT);
  setLed(false, false, true);
  Wire.begin(PIN_SDA, PIN_SCL);
  if (!oled.begin(SSD1306_SWITCHCAPVCC, 0x3C)) Serial.println("OLED not found at 0x3C");
  oled.clearDisplay(); oled.setTextColor(SSD1306_WHITE); oled.setTextSize(2);
  oled.setCursor(0, 0); oled.print("MedSafe"); oled.setTextSize(1);
  oled.setCursor(0, 24); oled.print("Connecting Wi-Fi..."); oled.display();
  sensors.begin();
  connectWifi();
  configTime(5 * 3600 + 1800, 0, "pool.ntp.org", "time.google.com");   // Sri Lanka = UTC+5:30
  takeReading();
  flushQueue();
  fetchSummary();
  lastRead = lastSummary = millis();
  showStatus();
}

void loop() {
  uint32_t now = millis();
  if (now - lastRead >= READ_EVERY_MS) {
    lastRead = now;
    takeReading();
    flushQueue();
    showStatus();
  }
  if (now - lastSummary >= SUMMARY_EVERY_MS) {
    lastSummary = now;
    fetchSummary();
    showStatus();
  }
  delay(50);
}
