"""
Event bus from this car's edge agent to every open UI websocket.
emit() is safe to call from worker threads (pipeline, Bluetooth listener, sync loop).
Sends to one socket are serialised with a per-socket lock — the status loop, event
broadcasts and the pipeline stream all write to the same sockets.
"""
import asyncio
import json
import uuid
from typing import Dict

from fastapi import WebSocket
from starlette.websockets import WebSocketState


class ConnectionManager:
    def __init__(self):
        self._connections: Dict[str, WebSocket] = {}
        self._locks: Dict[str, asyncio.Lock] = {}
        self._loop: asyncio.AbstractEventLoop | None = None
        self._tasks: set = set()

    def set_loop(self, loop):
        self._loop = loop

    async def connect(self, websocket: WebSocket, key: str | None = None) -> str:
        await websocket.accept()
        return self.register(websocket, key)

    def register(self, websocket: WebSocket, key: str | None = None) -> str:
        """Add an already-accepted socket (e.g. the pipeline socket) to the broadcast set."""
        key = key or uuid.uuid4().hex
        self._connections[key] = websocket
        self._locks[key] = asyncio.Lock()
        return key

    def disconnect(self, key: str):
        self._connections.pop(key, None)
        self._locks.pop(key, None)

    async def send_text(self, key: str, text: str):
        ws, lock = self._connections.get(key), self._locks.get(key)
        if ws is None or lock is None:
            return
        try:
            async with lock:
                await ws.send_text(text)
        except Exception:
            if ws.client_state != WebSocketState.CONNECTED or ws.application_state != WebSocketState.CONNECTED:
                self.disconnect(key)

    async def send(self, key: str, data: dict):
        await self.send_text(key, json.dumps(data, default=str))

    async def broadcast(self, data: dict):
        text = json.dumps(data, default=str)
        await asyncio.gather(*(self.send_text(k, text) for k in list(self._connections)))

    def emit(self, data: dict):
        """Fire-and-forget broadcast from any thread or coroutine."""
        if self._loop is None:
            return
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is self._loop:
            task = self._loop.create_task(self.broadcast(data))
            self._tasks.add(task)                      # keep a reference until it has run
            task.add_done_callback(self._tasks.discard)
        else:
            asyncio.run_coroutine_threadsafe(self.broadcast(data), self._loop)

    def active_sessions(self):
        return list(self._connections.keys())


manager = ConnectionManager()
