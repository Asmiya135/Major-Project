import asyncio
import json
from typing import Dict
from fastapi import WebSocket


class ConnectionManager:
    def __init__(self):
        self._connections: Dict[str, WebSocket] = {}

    async def connect(self, websocket: WebSocket, session_id: str):
        await websocket.accept()
        self._connections[session_id] = websocket

    def disconnect(self, session_id: str):
        self._connections.pop(session_id, None)

    async def send(self, session_id: str, data: dict):
        ws = self._connections.get(session_id)
        if ws:
            try:
                await ws.send_text(json.dumps(data))
            except Exception:
                self.disconnect(session_id)

    async def broadcast(self, data: dict):
        dead = []
        for sid, ws in self._connections.items():
            try:
                await ws.send_text(json.dumps(data))
            except Exception:
                dead.append(sid)
        for sid in dead:
            self.disconnect(sid)

    def active_sessions(self):
        return list(self._connections.keys())


manager = ConnectionManager()
