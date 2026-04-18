# botversion-sdk-python/botversion-sdk/client.py
import json
import threading
import urllib.request
import urllib.parse
import urllib.error
import atexit


class BotVersionClient:
    SDK_VERSION = "1.0.0"

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
            url = self.platform_url + "/api/sdk/register-endpoints"
            print(f"[BotVersion SDK] DEBUG — posting to: {url}")
            print(f"[BotVersion SDK] DEBUG — api_key: {self.api_key}")
            print(f"[BotVersion SDK] DEBUG — endpoint count: {len(endpoints)}")
            data = self._post("/api/sdk/register-endpoints", {
                "workspaceKey": self.api_key,
                "endpoints": endpoints,
            })
            print(f"[BotVersion SDK] DEBUG — response: {data}")
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
        """
        Called by the runtime interceptor when a new endpoint is discovered.
        Mirrors JS client.updateEndpoint()
        """
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

    # ── Agent chat (sync) ────────────────────────────────────────────────────

    def agent_chat(self, payload):
        """
        Send a user message to the BotVersion agent.
        Mirrors JS client.agentChat()
        """
        print(f"[BotVersion] agentChat payload: {json.dumps(payload)}")
        print(f"[BotVersion] api_key: {self.api_key}")

        return self._post("/api/chatbot/widget-chat", {
            "chatbotId": payload.get("chatbot_id"),
            "publicKey": payload.get("public_key"),
            "query": payload.get("message", ""),
            "previousChats": payload.get("conversation_history", []),
            "pageContext": payload.get("page_context", {}),
            "userContext": payload.get("user_context", {}),
        })

    # ── Agent chat (async — FastAPI) ─────────────────────────────────────────

    async def agent_chat_async(self, payload):
        """
        Async version of agent_chat for FastAPI.
        Uses asyncio-compatible HTTP instead of urllib.
        """
        print(f"[BotVersion] agentChat (async) payload: {json.dumps(payload)}")
        print(f"[BotVersion] api_key: {self.api_key}")

        return await self._post_async("/api/chatbot/widget-chat", {
            "chatbotId": payload.get("chatbot_id"),
            "publicKey": payload.get("public_key"),
            "query": payload.get("message", ""),
            "previousChats": payload.get("conversation_history", []),
            "pageContext": payload.get("page_context", {}),
            "userContext": payload.get("user_context", {}),
        })

    # ── Agent tool result ────────────────────────────────────────────────────

    def agent_tool_result(self, session_token, result, session_data=None):
        """
        Send the result of an API call back to the agent.
        Mirrors JS client.agentToolResult()
        """
        return self._post("/api/sdk/agent-tool-result", {
            "sessionToken": session_token,
            "sessionData": session_data,
            "result": result,
        })

    async def agent_tool_result_async(self, session_token, result, session_data=None):
        return await self._post_async("/api/sdk/agent-tool-result", {
            "sessionToken": session_token,
            "sessionData": session_data,
            "result": result,
        })

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
                "X-BotVersion-SDK": self.SDK_VERSION,
            },
        )

        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                response_data = res.read().decode("utf-8")
                print(f"[BotVersion DEBUG] _post {path} raw response: {response_data[:500]}")  # ← ADD
                parsed = json.loads(response_data)
                print(f"[BotVersion DEBUG] _post {path} parsed keys: {list(parsed.keys())}")   # ← ADD
                return parsed
        except urllib.error.HTTPError as e:
            error_body = e.read().decode("utf-8")
            print(f"[BotVersion DEBUG] HTTPError {e.code} from {path}: {error_body[:300]}")
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
            print(f"[BotVersion DEBUG] Exception in _post {path}: {type(e).__name__}: {e}")    # ← ADD
            raise RuntimeError(f"HTTP error: {e}")

    def _get(self, path):
        url = self.platform_url + path

        req = urllib.request.Request(
            url,
            method="GET",
            headers={"X-BotVersion-SDK": self.SDK_VERSION},
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
        """
        Async POST using asyncio — no extra dependencies needed (Python 3.11+).
        Falls back to running sync version in a thread executor for older Python.
        """
        import asyncio

        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, self._post, path, data)

    async def _get_async(self, path):
        import asyncio

        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, self._get, path)
    


    # ── Make a call to the user's own API ────────────────────────────────────

    def make_user_api_call(self, method, url, body=None, headers=None):
        """
        Makes an HTTP call to the user's own app endpoints.
        Forwards the original browser auth headers so the user is authenticated.
        """
        import urllib.request
        import json

        body_bytes = json.dumps(body).encode("utf-8") if body else None

        all_headers = {
            "Content-Type": "application/json",
        }
        if headers:
            all_headers.update(headers)

        req = urllib.request.Request(
            url,
            data=body_bytes,
            method=method.upper(),
            headers=all_headers,
        )

        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                response_data = res.read().decode("utf-8")
                print(f"[BotVersion SDK] make_user_api_call {method} {url} → {res.status}")
                try:
                    return {"status": res.status, "data": json.loads(response_data)}
                except Exception:
                    return {"status": res.status, "data": response_data}
        except urllib.error.HTTPError as e:
            error_body = e.read().decode("utf-8")
            print(f"[BotVersion SDK] make_user_api_call HTTP error {e.code}: {error_body[:200]}")
            try:
                return {"status": e.code, "data": json.loads(error_body)}
            except Exception:
                return {"status": e.code, "data": error_body}
        except Exception as e:
            print(f"[BotVersion SDK] make_user_api_call failed: {e}")
            return {"status": 500, "data": str(e)}

    async def make_user_api_call_async(self, method, url, body=None, headers=None):
        """
        Async version of make_user_api_call for FastAPI.
        """
        import asyncio
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            None,
            lambda: self.make_user_api_call(method, url, body, headers)
        )