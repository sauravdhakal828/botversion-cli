# botversion-sdk-python/botversion-sdk/client.py
import json
import threading
import urllib.request
import urllib.parse
import urllib.error
import atexit


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