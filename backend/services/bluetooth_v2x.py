"""
V2X hazard alerts between cars over Bluetooth — works with no network at all.

Transports (config.BT_MODE):
  rfcomm — real Bluetooth Classic RFCOMM sockets (Python stdlib, Windows/Linux).
           The receiving car listens on BT_CHANNEL; the sender connects to each paired
           peer MAC in BT_PEERS and writes one JSON line per hazard.
  sim    — Bluetooth simulation for a one-laptop demo: a loopback multicast group stands
           in for the radio so two car agents on the same machine can hear each other.
  auto   — both: real RFCOMM where available, plus the simulation.

Geofence: the receiving car computes the haversine distance from its own GPS position to
the broadcast hazard. Within V2X_RADIUS_M (15 m) → immediate "hazard ahead" alert.
Farther away → the hazard is remembered and alerts the moment the car drives inside 15 m.
"""
import json
import socket
import struct
import threading
import time
import uuid

import config
from services import edge_store
from services.edge_state import state, haversine_m
from websocket_manager import manager

def _resolve_sim_iface() -> str:
    if config.BT_SIM_IFACE != "lan":
        return config.BT_SIM_IFACE
    try:  # the local address the OS would use to reach the server = this laptop's LAN IP
        host = config.SERVER_URL.split("//")[-1].split(":")[0].split("/")[0]
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect((host if host not in ("localhost", "127.0.0.1") else "8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "0.0.0.0"


_SIM_IFACE = _resolve_sim_iface()


class V2XBluetooth:
    def __init__(self):
        self.rfcomm_ok = False
        self.sim_ok = False
        self.rfcomm_error = ""
        self.sim_error = ""
        self.sent = 0
        self.received = 0
        self.local_mac = None
        self.channel = None

    # ── lifecycle ─────────────────────────────────────────────────────────
    def start(self):
        mode = config.BT_MODE
        if mode in ("auto", "rfcomm"):
            threading.Thread(target=self._rfcomm_listener, daemon=True).start()
        if mode in ("auto", "sim"):
            threading.Thread(target=self._sim_listener, daemon=True).start()
        time.sleep(0.3)
        self._publish_status()

    def _publish_status(self):
        state.bt_status = {
            "mode": config.BT_MODE,
            "rfcomm": {"listening": self.rfcomm_ok, "local_mac": self.local_mac, "channel": self.channel,
                       "address": f"{self.local_mac}@{self.channel}" if self.rfcomm_ok else None,
                       "peers": config.BT_PEERS, "error": self.rfcomm_error},
            "sim": {"listening": self.sim_ok, "iface": _SIM_IFACE,
                    "group": f"{config.BT_SIM_GROUP}:{config.BT_SIM_PORT}",
                    "error": self.sim_error},
            "radius_m": config.V2X_RADIUS_M,
            "sent": self.sent, "received": self.received,
        }

    # ── real Bluetooth RFCOMM ─────────────────────────────────────────────
    def _rfcomm_listener(self):
        if not hasattr(socket, "AF_BLUETOOTH"):
            self.rfcomm_error = "this Python build has no AF_BLUETOOTH"
            return
        any_addr = getattr(socket, "BDADDR_ANY", "00:00:00:00:00:00")
        srv, last_err = None, None
        # Two cars on one laptop can't share a channel, so take the first free one
        for ch in range(config.BT_CHANNEL, config.BT_CHANNEL + 8):
            try:
                s = socket.socket(socket.AF_BLUETOOTH, socket.SOCK_STREAM, socket.BTPROTO_RFCOMM)
                s.bind((any_addr, ch))
                s.listen(4)
                srv = s
                self.local_mac, self.channel = s.getsockname()[0], ch
                break
            except OSError as e:
                last_err = e
                s.close()
        if srv is None:
            self.rfcomm_error = f"no Bluetooth adapter / bind failed: {last_err}"
            self._publish_status()
            return
        self.rfcomm_ok = True
        self._publish_status()
        while True:
            try:
                conn, addr = srv.accept()
                threading.Thread(target=self._rfcomm_read, args=(conn, addr), daemon=True).start()
            except OSError:
                time.sleep(1)

    def _rfcomm_read(self, conn, addr):
        buf = b""
        try:
            conn.settimeout(5)
            while b"\n" not in buf and len(buf) < 65536:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                buf += chunk
        except OSError:
            pass
        finally:
            conn.close()
        for line in buf.splitlines():
            try:
                self._on_message(json.loads(line), f"bluetooth-rfcomm ({addr[0]})")
            except ValueError:
                pass

    def _rfcomm_send(self, payload: bytes) -> list:
        results = []
        if not hasattr(socket, "AF_BLUETOOTH"):
            return results
        for peer in config.BT_PEERS:
            mac, _, ch = peer.partition("@")          # "AA:BB:CC:DD:EE:FF" or "AA:BB:…@5"
            try:
                s = socket.socket(socket.AF_BLUETOOTH, socket.SOCK_STREAM, socket.BTPROTO_RFCOMM)
                s.settimeout(4)
                s.connect((mac, int(ch) if ch else config.BT_CHANNEL))
                s.sendall(payload + b"\n")
                s.close()
                results.append({"peer": peer, "ok": True})
            except OSError as e:
                results.append({"peer": peer, "ok": False, "error": str(e)})
        return results

    # ── Bluetooth simulation (one-laptop demo) ────────────────────────────
    def _sim_listener(self):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind(("", config.BT_SIM_PORT))
            mreq = struct.pack("4s4s", socket.inet_aton(config.BT_SIM_GROUP), socket.inet_aton(_SIM_IFACE))
            s.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
            self.sim_ok = True
            self._publish_status()
        except OSError as e:
            self.sim_error = str(e)
            self._publish_status()
            return
        while True:
            try:
                data, _ = s.recvfrom(65536)
                self._on_message(json.loads(data), "bluetooth-sim")
            except (OSError, ValueError):
                time.sleep(0.05)

    def _sim_send(self, payload: bytes) -> bool:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
            s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(_SIM_IFACE))
            s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 1)
            s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_LOOP, 1)
            s.sendto(payload, (config.BT_SIM_GROUP, config.BT_SIM_PORT))
            s.close()
            return True
        except OSError as e:
            self.sim_error = str(e)
            return False

    # ── sending ───────────────────────────────────────────────────────────
    def broadcast_hazard(self, hazard: dict) -> dict:
        t = state.telemetry
        msg = {
            "v": 1, "type": "hazard", "msg_id": uuid.uuid4().hex,
            "from_client": config.CLIENT_ID, "from_name": config.CLIENT_NAME,
            "hazard_type": hazard["hazard_type"], "severity": hazard.get("severity", "medium"),
            "latitude": hazard["latitude"], "longitude": hazard["longitude"],
            "fusion_score": hazard.get("fusion_score"), "verified": hazard.get("verified", False),
            "sender_lat": t.lat, "sender_lon": t.lon, "sent_at": time.time(),
        }
        payload = json.dumps(msg).encode()
        result = {"msg_id": msg["msg_id"], "transports": []}
        if config.BT_MODE in ("auto", "sim") and self.sim_ok:
            if self._sim_send(payload):
                result["transports"].append("bluetooth-sim")
        if config.BT_MODE in ("auto", "rfcomm") and config.BT_PEERS:
            peers = self._rfcomm_send(payload)
            result["rfcomm_peers"] = peers
            if any(p["ok"] for p in peers):
                result["transports"].append("bluetooth-rfcomm")
        self.sent += 1
        self._publish_status()
        state.add_log("v2x", f"BT broadcast {msg['hazard_type']} via {', '.join(result['transports']) or 'none'}")
        manager.emit({**msg, "type": "bt_sent", "transports": result["transports"],
                      "rfcomm_peers": result.get("rfcomm_peers", [])})
        return result

    # ── receiving + 15 m geofence ─────────────────────────────────────────
    def _on_message(self, msg: dict, transport: str):
        if msg.get("type") != "hazard" or msg.get("from_client") == config.CLIENT_ID:
            return
        if not edge_store.add_peer_hazard(msg, transport):
            return  # already heard this broadcast on another transport
        self.received += 1
        self._publish_status()
        t = state.telemetry
        d = haversine_m(t.lat, t.lon, msg["latitude"], msg["longitude"])
        inside = d <= config.V2X_RADIUS_M
        state.add_log("v2x", f"BT received {msg['hazard_type']} from {msg.get('from_client')} "
                             f"({d:.1f} m away, {'ALERT' if inside else 'watching'})")
        manager.emit({**msg, "type": "bt_received", "transport": transport, "distance_m": round(d, 1),
                      "inside_radius": inside, "radius_m": config.V2X_RADIUS_M})
        if inside:
            self._alert(msg, d, transport)

    def _alert(self, msg: dict, dist: float, transport: str):
        edge_store.mark_peer_alerted(msg["msg_id"])
        manager.emit({
            **msg,
            "type": "bt_alert", "transport": transport, "distance_m": round(dist, 1),
            "radius_m": config.V2X_RADIUS_M,
            "message": f"⚠ {msg['hazard_type'].replace('_', ' ').title()} {dist:.0f} m ahead — "
                       f"reported by {msg.get('from_name') or msg.get('from_client')} over Bluetooth",
        })

    def check_geofence(self):
        """Called on every position update: alert for remembered hazards we just drove into."""
        t = state.telemetry
        for row in edge_store.peer_hazards(only_unalerted=True):
            msg = row["data"]
            d = haversine_m(t.lat, t.lon, msg["latitude"], msg["longitude"])
            if d <= config.V2X_RADIUS_M:
                self._alert(msg, d, row["transport"])


v2x = V2XBluetooth()
