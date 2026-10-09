#!/usr/bin/env python
"""
Build-time backend endpoint scanner. Run this as part of your deploy
pipeline (Procfile 'release' step, build.sh, or Dockerfile RUN step) so
endpoints are reported even on serverless platforms where the live
interceptor's scan-trigger route may not be reachable.
"""
import os
import sys

from botversion_sdk.client import BotVersionClient
from botversion_sdk.scanner import scan_routes_static, detect_framework_from_deps


def _load_env_files(cwd):
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    for filename in (".env", ".env.local"):
        filepath = os.path.join(cwd, filename)
        if os.path.exists(filepath):
            load_dotenv(filepath, override=False)


def main():
    cwd = os.getcwd()
    _load_env_files(cwd)

    api_key = os.environ.get("BOTVERSION_API_KEY")
    platform_url = os.environ.get("BOTVERSION_PLATFORM_URL", "https://console.botversion.com")

    if not api_key:
        print("[botversion] BOTVERSION_API_KEY environment variable is not set. Skipping backend endpoint scan.")
        sys.exit(0)

    framework = detect_framework_from_deps(cwd)
    if not framework:
        print("[botversion] No supported backend framework detected. Skipping backend endpoint scan.")
        sys.exit(0)

    endpoints = scan_routes_static(cwd, framework)

    if not endpoints:
        print(f"[botversion] No backend endpoints found via static scan. detected_framework={framework}")
        sys.exit(0)

    client = BotVersionClient({"api_key": api_key, "platform_url": platform_url})
    try:
        client.register_endpoints_now(endpoints)
        print(f"[botversion] Reported {len(endpoints)} backend endpoints. detected_framework={framework}")
    except Exception as e:
        print(f"[botversion] Failed to report backend endpoints: {e}")

    sys.exit(0)


if __name__ == "__main__":
    main()