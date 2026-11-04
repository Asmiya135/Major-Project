# Volkswagen Hazard Detection — client/server system

Two separate systems:

| System | Folder | Port | Runs where |
|---|---|---|---|
| **Global server** (one for everyone) | `server/` | 8000 | cloud / one laptop |
| **Client edge agent** (one per car — runs every ML model) | `backend/` | 8001 = car A, 8002 = car B | in each car |
| **Car UI** (dashboard for one car, picked with `?edge=`) + server console | `frontend/` | 5173 | browser |

```
 CAR (client)                                             GLOBAL SERVER
 ┌───────────────────────────────────────────────┐        ┌──────────────────────────────────┐
 │ camera → M1 capture rate by speed + AKS dedup  │        │ POST /api/reports                │
 │        → M2 dehaze/low-light (only if needed)  │  online│   haversine clustering (25 m)    │
 │        → privacy blur                          │ ──────▶│   → one alert per cluster        │
 │        → M3 heads: H4 road, H3 depth, H2 seg,  │        │   DBSCAN recluster               │
 │          H1 det, H5 stalled (SORT), flow, IMU  │        │ POST /api/hazards/route          │
 │        → M4 fusion engine (FL-trained weights) │◀────── │   hazards on a planned route     │
 │        → M5 HIGH: outbox → server / queue      │  route │ Federated learning               │
 │               + Bluetooth V2X broadcast        │ hazards│   FedAvg of fusion weights       │
 │          M6 MEDIUM: GenAI question → driver    │        │   detector fine-tune on verified │
 │               yes → report (verified photo)    │◀────── │   photos → new versions to cars  │
 │ offline: outbox queue, flushed when back online│ weights└──────────────────────────────────┘
 │ Bluetooth: alert when within 15 m (haversine)  │
 └───────────────────────────────────────────────┘
        ▲ Bluetooth (RFCOMM, or simulation on one laptop) ▼   other cars
```

## Run

```bat
start.bat            :: server + car A + car B + UI, opens the three demo tabs
```
or individually: `start_server.bat`, `start_car.bat car-A 8001`, `start_car.bat car-B 8002`, `cd frontend && npm run dev`.

| Page | URL |
|---|---|
| Car A live detection | http://localhost:5173/pipeline?edge=8001 |
| Car B live detection / V2X receiver | http://localhost:5173/pipeline?edge=8002 |
| Trip planning + navigation (car A) | http://localhost:5173/?edge=8001 |
| Global server console | http://localhost:5173/server |

Optional environment variables (set before `start_car.bat`):

* `ANTHROPIC_API_KEY` — GenAI-written verification questions (without it a template question is used).
* `BT_PEERS=AA:BB:CC:DD:EE:FF@4` — real Bluetooth RFCOMM peers for a two-laptop demo. Each car shows its own
  address (`MAC@channel`) in the status bar's Bluetooth badge. Pair the laptops in Windows first.
* `SERVER_URL=http://<server-laptop-ip>:8000` — when the server is on another machine.

To reset the demo: stop everything and delete `server/data/` and `backend/client_data/`.

## Two-laptop demo drive (simulated road, real Bluetooth alert)

| Laptop | Run |
|---|---|
| 1 — server + car A | `start_server.bat`, then `start_client_laptop.bat car-A 127.0.0.1` (run `ipconfig` for this laptop's Wi-Fi IP) |
| 2 — car B | `start_client_laptop.bat car-B <laptop-1 IP>` |

For real Bluetooth, pair the two laptops and add the other car's address as the 3rd argument (see below);
the Bluetooth simulation over Wi-Fi runs as a backup either way.

1. On **both** laptops open `http://localhost:5173/?edge=8001`, enter the **same start and destination**.
2. Click **Demo drive (simulated road)** on car A, then on car B. Both cars drive themselves along the route
   (car A defaults to 40 km/h, car B to 25 km/h — change with the speed slider; A must reach the hazard first).
3. A **pre-mapped pothole** sits 300 m along the route. When car A is 25 m from it, its camera "detects" it:
   the real fusion engine scores it → report to the server (or the offline queue if car A is switched OFFLINE)
   → **Bluetooth broadcast**.
4. Car B shows `📶 pothole from car-A via bluetooth-… — N m away · alert when inside 15 m`, counting down,
   then the red **V2X ALERT** banner + voice when it is inside 15 m (haversine). Car B does not re-report a
   hazard it already heard about.
5. The server console (`/server` on laptop 1) shows car A's report and its cluster.

Run `reset_demo.bat` (with the server/car windows closed) between takes, so earlier reports don't show up as
known route hazards.

## Three laptops (server · car A · car B)

All three laptops need this whole project folder (including `backend/venv`, the model files and
`frontend/node_modules` + `frontend/.env`) and must be on the **same Wi-Fi / hotspot**.

| Laptop | Run | Opens |
|---|---|---|
| 1 — server | `start_server_laptop.bat` (prints its IP, e.g. `192.168.1.20`) | `/server` console |
| 2 — car A | `start_client_laptop.bat car-A 192.168.1.20` | car A `/pipeline` |
| 3 — car B | `start_client_laptop.bat car-B 192.168.1.20` | car B `/pipeline` |

1. **Server reachable?** On each car laptop, open `http://<server-ip>:8000/api/health` in the browser. If it
   doesn't load, on the server laptop run (admin cmd):
   `netsh advfirewall firewall add rule name="VW hazard server" dir=in action=allow protocol=TCP localport=8000`.
   The car's status bar turns **ONLINE** once it can reach the server.
2. **Real Bluetooth (car ↔ car):** pair laptops 2 and 3 in Windows Bluetooth settings. Each car's status bar
   Bluetooth badge shows its own address, e.g. `RFCOMM 4C:5F:70:87:52:61@4`. Restart each car with the
   *other* car's address as the third argument:
   `start_client_laptop.bat car-A 192.168.1.20 <car-B-address>` and
   `start_client_laptop.bat car-B 192.168.1.20 <car-A-address>`.
   Click *BT broadcast pothole 5 m ahead* on car A: the feed shows `RFCOMM <address> ✓` on success, or the error.
3. **Bluetooth fallback:** each car also runs the Bluetooth simulation over the Wi-Fi network (`BT_SIM_IFACE=lan`),
   so V2X alerts still arrive if pairing fails. The feed and the alert banner name the transport
   (`bluetooth-rfcomm` vs `bluetooth-sim`). If Windows asks whether Python may use private networks, click **Allow**.
4. **Offline demo:** use the ONLINE/OFFLINE switch on car A (it only cuts car A ↔ server). Don't turn Wi-Fi off,
   because the Bluetooth simulation fallback uses it.
5. **Same place for the 15 m geofence:** the two laptops are physically together, so put both cars at the same
   coordinates (car B's *Position* panel → GPS, or type car A's lat/lon; use the 5 m arrows to move in/out of 15 m).

## Demo script (what to show)

1. **Live camera detection** — `/pipeline?edge=8001` → *Start camera* → *Start detection*. Point the camera at
   a pothole / stalled-car video on a phone, or use the *Dashcam video* tab. Each of the 11 steps shows its
   labelled image.
2. **Frame rate follows speed** — move the speed slider: *target fps* changes (speed ÷ 5 m per frame,
   0.5–4 fps), *measured fps* follows, and duplicate frames are counted as *skipped dup*.
   In video mode the sampling interval (`sampling every N frames`) changes live.
3. **All heads, labelled** — H2 card: mask + `W × L m, area m², depth cm, distance, ON ROAD / ON PAVEMENT / OFF ROAD,
   lane`; H4: road (green) vs pavement (blue); H3: depth map; H1: detections; H5: `ID… STALLED / moving,
   tracked n/5 frames, stationarity`; Motion: optical flow + IMU (*Simulate bump* button).
4. **Fusion engine** — the *Fusion engine calculation* panel: every signal × weight = contribution,
   sigmoid → score → HIGH / MEDIUM / DISCARD.
5. **New hazard → server** — a HIGH hazard appears in the event feed as `→ server cluster #n (created)`;
   open `/server` to see the report, its photo and the cluster.
6. **Ambiguous → human in the loop** — a MEDIUM hazard opens the verification dialog with the photo and the
   spoken question; hold the mic and say "yes" (or tap *Yes*) → it is sent as *driver-verified*.
7. **Offline + Bluetooth** — click the green *ONLINE* badge on car A to go *OFFLINE*. Put car B within 15 m
   (car B tab: same position, or use the 5 m arrows). Detect a hazard on car A → it is *QUEUED OFFLINE* and
   broadcast over Bluetooth → car B shows the red *V2X ALERT* banner (and speaks it).
   Move car B 100 m away and broadcast again: car B logs *outside 15 m → watching* and alerts only when it
   drives inside 15 m. (*BT broadcast pothole 5 m ahead* sends a test hazard.)
8. **Back online → queue flushed** — click *OFFLINE* again → event feed shows
   `Offline-queued … uploaded → cluster #n`; the server console counts *From offline queues*.
9. **Server clustering** — report the same pothole several times / from both cars: the server merges them
   into one cluster (count goes up, one alert). *Run DBSCAN recluster* merges clusters that drifted together.
10. **Federated learning** — after two driver answers the car trains locally and pushes only weights; the server
    runs FedAvg, publishes `fusion vN` with performance measures, and every car installs it (status bar shows
    the new version). *Train detector* fine-tunes Head-1 on the verified photos; cars download it automatically.

Route alerts: on the Trip page pick a destination → hazards on that route are downloaded from the server and cached
on the car (work offline). Start the drive with *simulate driving along route* → alert once per cluster within 150 m.
