# botversion-sdk-python/botversion-sdk/client.py
import json
import threading
import urllib.request
import urllib.parse
import urllib.error
import atexit
import time
import logging

logging.getLogger("websocket").setLevel(logging.CRITICAL)

class BotVersionClient:

    def __init__(self, options):
        self.api_key = options["api_key"]
        platform_url = options.get("platform_url", "http://localhost:3000")

        # Force IPv4 — on Windows, localhost resolves to ::1 (IPv6) in browsers
        # but Python's urllib uses 127.0.0.1 (IPv4), causing connection timeouts
        platform_url = platform_url.replace("http://localhost", "http://127.0.0.1")
        platform_url = platform_url.replace("https://localhost", "https://127.0.0.1")

        self.platform_url = platform_url
        self.debug = options.get("debug", False)
        self.timeout = options.get("timeout", 30)
        self._flush_delay = options.get("flush_delay", 3)

        # Batch queue
        self._queue = []
        self._flush_timer = None
        self._lock = threading.Lock()
        atexit.register(self._flush)

        # WebSocket state
        self._ws = None
        self._executor = None
        self._pending_calls = {}

    # ── Set executor (called by interceptor after attach) ────────────────────────
    def set_executor(self, executor_fn):
        self._executor = executor_fn
        if self.debug:
            print("[BotVersion SDK] ✅ Executor registered")

    # ── WebSocket connection ──────────────────────────────────────────────────────
    def connect(self):
        # ✅ No warmup needed — ws-server.js is always running
        t = threading.Thread(target=self._ws_loop, daemon=True)
        t.start()

    def _ws_loop(self):
        ws_url = self.platform_url \
            .replace("https://", "wss://") \
            .replace("http://", "ws://") \
            .replace(":3000", ":3001")
        # ✅ ws-server.js accepts connections at root path
        ws_url = ws_url + "?apiKey=" + urllib.parse.quote(self.api_key)

        while True:
            try:
                import websocket
                ws = websocket.WebSocketApp(
                    ws_url,
                    on_open=self._on_ws_open,
                    on_message=self._on_ws_message,
                    on_error=self._on_ws_error,
                    on_close=self._on_ws_close,
                )
                with self._lock:
                    self._ws = ws
                ws.run_forever(ping_interval=30, ping_timeout=10)
            except ImportError:
                print("[BotVersion SDK] ❌ websocket-client not installed. Run: pip install websocket-client")
                break
            except Exception as e:
                if self.debug:
                    print(f"[BotVersion SDK] ⚠ WebSocket error: {e}")
            if self.debug:
                print("[BotVersion SDK] Reconnecting in 5 seconds...")
            time.sleep(5)

    def _on_ws_open(self, ws): 
        if self.debug:
            print("[BotVersion SDK] ✅ WebSocket connected to platform")
        ws.send(json.dumps({
            "type": "IDENTIFY",
            "apiKey": self.api_key,
        }))

    def _on_ws_message(self, ws, message):
        try:
            data = json.loads(message)
            msg_type = data.get("type")

            if msg_type == "EXECUTE_CALL":
                threading.Thread(
                    target=self._handle_execute_call,
                    args=(data,),
                    daemon=True,
                ).start()

        except Exception as e:
            if self.debug:
                print(f"[BotVersion SDK] ⚠ Error handling message: {e}")

    def _handle_execute_call(self, data):
        call_id = data.get("callId")
        method = data.get("method")
        path = data.get("path")
        body = data.get("body")
        cookies = data.get("cookies", "")
        headers = data.get("headers", {})
        base_url = data.get("baseUrl", "http://127.0.0.1:8000")

        try:
            if not self._executor:
                raise RuntimeError("No executor registered")

            result = self._executor(method, path, body, cookies, headers, base_url)

        except Exception as e:
            result = {
                "status": 500,
                "ok": False,
                "data": {"error": str(e)},
            }

        # Send result back to platform
        try:
            with self._lock:
                ws = self._ws
            if ws:
                ws.send(json.dumps({
                    "type": "CALL_RESULT",
                    "callId": call_id,
                    "result": result,
                }))
        except Exception as e:
            if self.debug:
                print(f"[BotVersion SDK] ⚠ Failed to send result: {e}")

    def _on_ws_error(self, ws, error):
        if self.debug:
            print(f"[BotVersion SDK] ⚠ WebSocket error: {error}")

    def _on_ws_close(self, ws, close_status_code, close_msg):
        if self.debug:
            print("[BotVersion SDK] WebSocket closed — will reconnect")
        with self._lock:
            self._ws = None

    # ── Register endpoints (batched) ─────────────────────────────────────────

    def register_endpoints(self, endpoints):
        if not endpoints:
            return

        if self.debug:
            print(f"[BotVersion SDK] Queuing {len(endpoints)} endpoints for registration")

        with self._lock:
            self._queue.extend(endpoints)

            if self._flush_timer is None:
                self._flush_timer = threading.Timer(self._flush_delay, self._flush)
                self._flush_timer.daemon = True
                self._flush_timer.start()

    def register_endpoints_now(self, endpoints):
        if not endpoints:
            return
        try:
            data = self._post("/api/sdk/register-endpoints", {
                "workspaceKey": self.api_key,
                "endpoints": endpoints,
            })
            if self.debug:
                print(f"[BotVersion SDK] ✅ Registered {len(endpoints)} endpoints")
            return data
        except Exception as e:
            print(f"[BotVersion SDK] ⚠ Failed to register endpoints: {e}")

    # ── Flush batch ──────────────────────────────────────────────────────────

    def _flush(self):
        with self._lock:
            self._flush_timer = None
            if not self._queue:
                return
            to_send = self._queue[:]
            self._queue = []

        if self.debug:
            print(f"[BotVersion SDK] Flushing {len(to_send)} endpoints to platform")

        try:
            data = self._post("/api/sdk/register-endpoints", {
                "workspaceKey": self.api_key,
                "endpoints": to_send,
            })
            if self.debug:
                succeeded = data.get("succeeded", len(to_send))
                print(f"[BotVersion SDK] Registered {succeeded} endpoints successfully")
        except Exception as e:
            if self.debug:
                print(f"[BotVersion SDK] ⚠ Failed to register endpoints: {e}")

    # ── Update single endpoint (runtime interceptor) ─────────────────────────

    def update_endpoint(self, endpoint):
        try:
            self._post("/api/sdk/update-endpoint", {
                "workspaceKey": self.api_key,
                "method": endpoint.get("method"),
                "path": endpoint.get("path"),
                "requestBody": endpoint.get("request_body"),
                "responseBody": endpoint.get("response_body"),
                "detectedBy": endpoint.get("detected_by", "runtime"),
            })
        except Exception as e:
            if self.debug:
                print(f"[BotVersion SDK] ⚠ Failed to update endpoint: {e}")


    # ── Register frontend route patterns ─────────────────────────────────────────

    def register_route_patterns(self, patterns):
        if not patterns:
            return
        try:
            self._post("/api/sdk/register-route-patterns", {
                "workspaceKey": self.api_key,
                "patterns": patterns,
            })
            if self.debug:
                print(f"[BotVersion SDK] ✅ Registered {len(patterns)} route patterns")
        except Exception as e:
            if self.debug:
                print(f"[BotVersion SDK] ⚠ Failed to register route patterns: {e}")

    # ── Get all endpoints ────────────────────────────────────────────────────

    def get_endpoints(self):
        return self._get(
            f"/api/sdk/get-endpoints?workspaceKey={urllib.parse.quote(self.api_key)}"
        )

    # ── HTTP helpers (sync) ──────────────────────────────────────────────────

    def _post(self, path, data):
        url = self.platform_url + path
        body = json.dumps(data).encode("utf-8")

        req = urllib.request.Request(
            url,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Content-Length": str(len(body)),
            },
        )

        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                response_data = res.read().decode("utf-8")
                return json.loads(response_data)
        except urllib.error.HTTPError as e:
            error_body = e.read().decode("utf-8")
            try:
                parsed_error = json.loads(error_body)
                raise RuntimeError(
                    f"Platform returned {e.code}: {parsed_error.get('error', error_body)}"
                )
            except (json.JSONDecodeError, KeyError):
                raise RuntimeError(f"Platform returned {e.code}: {error_body}")
        except urllib.error.URLError as e:
            raise RuntimeError(f"Request failed: {e.reason}")
        except Exception as e:
            raise RuntimeError(f"HTTP error: {e}")

    def _get(self, path):
        url = self.platform_url + path

        req = urllib.request.Request(
            url,
            method="GET",
        )

        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                response_data = res.read().decode("utf-8")
                return json.loads(response_data)
        except urllib.error.HTTPError as e:
            error_body = e.read().decode("utf-8")
            try:
                parsed_error = json.loads(error_body)
                raise RuntimeError(
                    f"Platform returned {e.code}: {parsed_error.get('error', error_body)}"
                )
            except (json.JSONDecodeError, KeyError):
                raise RuntimeError(f"Platform returned {e.code}: {error_body}")
        except urllib.error.URLError as e:
            raise RuntimeError(f"Request failed: {e.reason}")
        except Exception as e:
            raise RuntimeError(f"HTTP error: {e}")

    # ── HTTP helpers (async) ─────────────────────────────────────────────────

    async def _post_async(self, path, data):
        import asyncio
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, self._post, path, data)

    async def _get_async(self, path):
        import asyncio
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, self._get, path)