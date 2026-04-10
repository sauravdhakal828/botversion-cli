# botversion-sdk-python/client.py
import json
import threading
import urllib.request
import urllib.parse
import urllib.error


class BotVersionClient:
    SDK_VERSION = "1.0.0"

    def __init__(self, options):
        self.api_key = options["api_key"]
        self.platform_url = options.get("platform_url", "https://app.botversion.com")
        self.debug = options.get("debug", False)
        self.timeout = options.get("timeout", 5)
        self._flush_delay = options.get("flush_delay", 3)

        # Batch queue
        self._queue = []
        self._flush_timer = None
        self._lock = threading.Lock()

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
                print(f"[BotVersion SDK] Registered {data.get('succeeded', len(to_send))} endpoints successfully")
        except Exception as e:
            if self.debug:
                print(f"[BotVersion SDK] ⚠ Failed to register endpoints: {e}")

    # ── Update single endpoint (runtime) ─────────────────────────────────────

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
        return self._get(f"/api/sdk/get-endpoints?workspaceKey={urllib.parse.quote(self.api_key)}")

    # ── HTTP helpers ─────────────────────────────────────────────────────────

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
                "X-BotVersion-SDK": self.SDK_VERSION,
            },
        )

        with urllib.request.urlopen(req, timeout=self.timeout) as res:
            return json.loads(res.read().decode("utf-8"))

    def _get(self, path):
        url = self.platform_url + path

        req = urllib.request.Request(
            url,
            method="GET",
            headers={"X-BotVersion-SDK": self.SDK_VERSION},
        )

        with urllib.request.urlopen(req, timeout=self.timeout) as res:
            return json.loads(res.read().decode("utf-8"))