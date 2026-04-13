#!/usr/bin/env python3
"""
botversion-sdk-python/botversion-sdk/cli/init.py

Main CLI entry point — runs when user types:
    python -m botversion_sdk.cli.init --key YOUR_KEY

Or via the installed script:
    botversion-init --key YOUR_KEY

Mirrors JS bin/init.js
"""

import os
import sys
import argparse

from . import detector
from . import generator
from . import writer
from . import prompts


# ── Colors ────────────────────────────────────────────────────────────────────

class C:
    RESET  = "\x1b[0m"
    BOLD   = "\x1b[1m"
    GREEN  = "\x1b[32m"
    YELLOW = "\x1b[33m"
    RED    = "\x1b[31m"
    CYAN   = "\x1b[36m"
    GRAY   = "\x1b[90m"
    WHITE  = "\x1b[37m"


def log(msg=""):     print(msg)
def info(msg):       print(f"{C.CYAN}  i{C.RESET}  {msg}")
def success(msg):    print(f"{C.GREEN}  v{C.RESET}  {msg}")
def warn(msg):       print(f"{C.YELLOW}  !{C.RESET}  {msg}")
def error(msg):      print(f"{C.RED}  x{C.RESET}  {msg}")
def step(msg):       print(f"\n{C.BOLD}{C.WHITE}  -> {msg}{C.RESET}")


# ── Banner ────────────────────────────────────────────────────────────────────

def print_banner():
    log()
    log(f"{C.CYAN}{C.BOLD}  +======================================+{C.RESET}")
    log(f"{C.CYAN}{C.BOLD}  |       BotVersion SDK Setup CLI       |{C.RESET}")
    log(f"{C.CYAN}{C.BOLD}  +======================================+{C.RESET}")
    log()


# ── Argument parsing ──────────────────────────────────────────────────────────

def parse_args():
    parser = argparse.ArgumentParser(
        description="BotVersion SDK auto-setup CLI",
        add_help=False,
    )
    parser.add_argument("--key", help="Your BotVersion workspace API key")
    parser.add_argument("--force", action="store_true", help="Force re-initialization")
    parser.add_argument("--cwd", help="Working directory (default: current directory)")
    parser.add_argument("--help", action="store_true", help="Show help")

    args, _ = parser.parse_known_args()
    return args


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    args = parse_args()

    print_banner()

    if args.help or not args.key:
        error("API key is required.")
        log()
        log("  Usage: botversion-init --key YOUR_WORKSPACE_KEY")
        log()
        log("  Get your key from: https://app.botversion.com/settings")
        log()
        sys.exit(1)

    cwd = os.path.abspath(args.cwd) if args.cwd else os.getcwd()
    changes = {"modified": [], "created": [], "backups": [], "manual": []}

    # ── Fetch project info from platform ──────────────────────────────────────
    step("Fetching project info from platform...")
    try:
        import urllib.request
        import json as _json
        url = f"https://chatbusiness-two.vercel.app/api/sdk/project-info?workspaceKey={args.key}"
        with urllib.request.urlopen(url) as response:
            project_info = _json.loads(response.read().decode())
        success(f"Project found — ID: {project_info.get('projectId')}")
    except Exception as e:
        error(f"Could not fetch project info: {e}")
        sys.exit(1)

    # ── Detect environment ────────────────────────────────────────────────────
    step("Scanning your project...")

    detected = detector.detect(cwd)

    detected["project_info"] = {
        "cdn_url": project_info.get("cdnUrl"),
        "api_url": project_info.get("apiUrl"),
        "project_id": project_info.get("projectId"),
        "public_key": project_info.get("publicKey"),
    }

    # ── Check if already initialized ─────────────────────────────────────────
    if detected.get("already_initialized") and not args.force:
        warn("BotVersion SDK is already initialized in this project.")
        log()
        log("  To reinitialize, run with --force flag:")
        log(f"  botversion-init --key {args.key} --force")
        log()
        sys.exit(0)

    # ── Framework check ───────────────────────────────────────────────────────
    step("Detecting framework...")

    framework = detected.get("framework", {})

    if not framework.get("name"):
        error("Could not detect a supported framework.")
        log()
        log("  Supported: FastAPI, Flask, Django")
        log("  Make sure you have them listed in requirements.txt or pyproject.toml")
        log()
        sys.exit(1)

    if not framework.get("supported"):
        warn(f"Detected: {framework['name']} (not yet supported for auto-setup)")
        log()
        log(generator.generate_manual_instructions(framework["name"], args.key))
        sys.exit(0)

    success(f"Framework: {framework['name']}")
    info(f"Package manager: {detected.get('virtualenv', 'pip')}")

    # ── Auth detection ────────────────────────────────────────────────────────
    step("Detecting auth library...")

    auth = detected.get("auth", {})

    if not auth.get("name"):
        warn("No auth library detected automatically.")
        auth = prompts.prompt_auth_library(framework["name"])
        detected["auth"] = auth
    elif not auth.get("supported"):
        warn(f"Detected auth: {auth['name']} (not yet supported for auto-setup)")
        warn("Will set up without user context — you can add it manually later.")
        proceed = prompts.confirm("Continue without auth?", default_yes=True)
        if not proceed:
            sys.exit(0)
        auth = {"name": auth["name"], "supported": False}
        detected["auth"] = auth
    else:
        success(f"Auth: {auth['name']}")

    # ── Route to framework setup ──────────────────────────────────────────────
    fw_name = framework["name"]

    if fw_name == "fastapi":
        setup_fastapi(detected, args, changes, cwd)
    elif fw_name == "flask":
        setup_flask(detected, args, changes, cwd)
    elif fw_name == "django":
        setup_django(detected, args, changes, cwd)

    # ── Write API key to .env ─────────────────────────────────────────────────
    backend_root = detected.get("backend_root", cwd)

    # Write to both root and backend_root to cover all cases
    env_paths_to_write = list(dict.fromkeys([
        os.path.join(backend_root, ".env"),  # backend first
        os.path.join(cwd, ".env"),           # root second
    ]))

    wrote_any = False
    user_declined = False

    for env_path in env_paths_to_write:
        env_content = ""
        if os.path.exists(env_path):
            with open(env_path, "r", encoding="utf-8") as f:
                env_content = f.read()

        if "BOTVERSION_API_KEY" not in env_content:
            if user_declined:
                break

            if not wrote_any:
                # Only ask once
                write_env = prompts.confirm("Add BOTVERSION_API_KEY to .env?", default_yes=True)
                if not write_env:
                    user_declined = True
                    warn("Skipped — add this manually to your .env:")
                    log()
                    log("    # BotVersion API key")
                    log(f"    BOTVERSION_API_KEY={args.key}")
                    log()
                    changes["manual"].append(
                        f"Add to your .env:\n\n    # BotVersion API key\n    BOTVERSION_API_KEY={args.key}"
                    )
                    break

            env_addition = generator.generate_env_line(args.key)
            writer.backup_file(env_path)
            with open(env_path, "w", encoding="utf-8") as f:
                f.write(env_content.rstrip() + env_addition)
            success(f"Added BOTVERSION_API_KEY to {os.path.relpath(env_path, cwd)}")
            changes["modified"].append(os.path.relpath(env_path, cwd))
            wrote_any = True
        else:
            info(f"BOTVERSION_API_KEY already exists in {os.path.relpath(env_path, cwd)} — skipping.")

    # ── Print summary ─────────────────────────────────────────────────────────
    log(writer.write_summary(changes))


# ── FastAPI setup ─────────────────────────────────────────────────────────────

def setup_fastapi(detected, args, changes, cwd):
    step("Setting up FastAPI...")
    backend_root = detected.get("backend_root", cwd)

    entry_point = detected.get("entry_point")

    if not entry_point or not os.path.exists(entry_point):
        manual_path = prompts.prompt_entry_point()

        candidates = [
            os.path.join(cwd, manual_path),
            os.path.join(backend_root, manual_path),
        ]
        candidates = list(dict.fromkeys(candidates))

        entry_point = None
        for candidate in candidates:
            if os.path.exists(candidate):
                entry_point = candidate
                break

        if not entry_point:
            error(f"File not found: {manual_path}")
            error(f"Looked in:")
            for c in candidates:
                error(f"  {c}")
            sys.exit(1)

    success(f"Entry point: {os.path.relpath(entry_point, cwd)}")

    generated = generator.generate_fastapi_init(detected, args.key)

    # Inject init block before uvicorn.run()
    # inject_before_run() handles imports internally
    full_code = generated.get("imports", "") + "\n\n" + generated["init_block"]
    run_call = detected.get("run_call")

    if run_call:
        result = writer.inject_before_run(entry_point, full_code, "fastapi")

        if result["success"]:
            success(f"Injected botversion_sdk.init() before uvicorn.run()")
            changes["modified"].append(os.path.relpath(entry_point, cwd))
            if result.get("backup"):
                changes["backups"].append(result["backup"])
        elif result["reason"] == "already_exists":
            warn("BotVersion already found — skipping injection.")
        else:
            _handle_missing_run_call(entry_point, generated["init_block"], generated.get("imports", ""), "fastapi", changes, cwd, detected)

    else:
        # No uvicorn.run() found — common in Docker/CLI projects, just append
        full_block = (generated.get("imports", "") + "\n\n" + generated["init_block"])
        result = writer.append_to_file(entry_point, full_block)
        if result["success"]:
            success("Injected botversion_sdk.init() into main.py")
            changes["modified"].append(os.path.relpath(entry_point, cwd))
        elif result["reason"] == "already_exists":
            warn("BotVersion already found — skipping injection.")

    # ── Inject script tag into frontend file ──────────────────────────────────
    _inject_frontend_script_tag(detected, changes, cwd, args.force)


# ── Flask setup ───────────────────────────────────────────────────────────────

def setup_flask(detected, args, changes, cwd):
    step("Setting up Flask...")

    entry_point = detected.get("entry_point")
    backend_root = detected.get("backend_root", cwd)

    if not entry_point or not os.path.exists(entry_point):
        warn("Could not find your server entry point automatically.")
        manual_path = prompts.prompt_entry_point()

        candidates = [
            os.path.join(cwd, manual_path),
            os.path.join(backend_root, manual_path),
        ]
        candidates = list(dict.fromkeys(candidates))

        entry_point = None
        for candidate in candidates:
            if os.path.exists(candidate):
                entry_point = candidate
                break

        if not entry_point:
            error(f"File not found: {manual_path}")
            error(f"Looked in:")
            for c in candidates:
                error(f"  {c}")
            sys.exit(1)

    success(f"Entry point: {os.path.relpath(entry_point, cwd)}")

    generated = generator.generate_flask_init(detected, args.key)

    # Inject init block before app.run()
    # inject_before_run() handles imports internally
    full_code = generated.get("imports", "") + "\n\n" + generated["init_block"]
    run_call = detected.get("run_call")

    if run_call:
        result = writer.inject_before_run(entry_point, full_code, "flask")

        if result["success"]:
            success("Injected botversion_sdk.init() before app.run()")
            changes["modified"].append(os.path.relpath(entry_point, cwd))
            if result.get("backup"):
                changes["backups"].append(result["backup"])
        elif result["reason"] == "already_exists":
            warn("BotVersion already found — skipping injection.")
        else:
            _handle_missing_run_call(entry_point, generated["init_block"], generated.get("imports", ""), "flask", changes, cwd, detected)

    else:
        full_block = (generated.get("imports", "") + "\n\n" + generated["init_block"])
        result = writer.append_to_file(entry_point, full_block)
        if result["success"]:
            success("Injected botversion_sdk.init() into app.py")
            changes["modified"].append(os.path.relpath(entry_point, cwd))
        elif result["reason"] == "already_exists":
            warn("BotVersion already found — skipping injection.")

    # ── Inject script tag into frontend file ──────────────────────────────────
    _inject_frontend_script_tag(detected, changes, cwd, args.force)


# ── Django setup ──────────────────────────────────────────────────────────────

def setup_django(detected, args, changes, cwd):
    step("Setting up Django...")

    backend_root = detected.get("backend_root", cwd)

    # 1. Find wsgi.py or asgi.py
    wsgi_path = detected.get("entry_point")

    if not wsgi_path or not os.path.exists(wsgi_path):
        warn("Could not find wsgi.py or asgi.py automatically.")
        manual_path = prompts.prompt_entry_point()

        candidates = [
            os.path.join(cwd, manual_path),
            os.path.join(backend_root, manual_path),
        ]
        candidates = list(dict.fromkeys(candidates))

        wsgi_path = None
        for candidate in candidates:
            if os.path.exists(candidate):
                wsgi_path = candidate
                break

        if not wsgi_path:
            error(f"File not found: {manual_path}")
            error(f"Looked in:")
            for c in candidates:
                error(f"  {c}")
            sys.exit(1)

    success(f"Entry point: {os.path.relpath(wsgi_path, cwd)}")

    # 2. Inject init code after get_wsgi_application()
    generated = generator.generate_django_wsgi_init(detected, args.key)
    result = writer.inject_after_wsgi(wsgi_path, generated)

    if result["success"]:
        success("Injected botversion_sdk.init() into wsgi.py")
        changes["modified"].append(os.path.relpath(wsgi_path, cwd))
        if result.get("backup"):
            changes["backups"].append(result["backup"])
    elif result["reason"] == "already_exists":
        warn("BotVersion already found in wsgi.py — skipping.")
    else:
        # Fallback: append to end
        append_result = writer.append_to_file(wsgi_path, generated)
        if append_result["success"]:
            success("Appended botversion_sdk.init() to wsgi.py")
            changes["modified"].append(os.path.relpath(wsgi_path, cwd))

    # 3. Inject CORS settings into settings.py
    step("Configuring CORS...")
    _inject_cors_settings(detected, changes, cwd)

    # 4. Find and update urls.py
    step("Adding chat URL to urls.py...")

    urls_candidates = [
        "urls.py",
        "config/urls.py",
        "core/urls.py",
        "app/urls.py",
        "src/urls.py",
        "backend/urls.py",
    ]

    urls_path = None
    for candidate in urls_candidates:
        for base in list(dict.fromkeys([cwd, backend_root])):
            full_path = os.path.join(base, candidate)
            if os.path.exists(full_path):
                try:
                    with open(full_path, "r", encoding="utf-8") as f:
                        content = f.read()
                    if "urlpatterns" in content:
                        urls_path = full_path
                        break
                except Exception:
                    continue
        if urls_path:
            break

    if not urls_path:
        urls_path = detector.find_file_with_content(cwd, "urlpatterns", [".py"], max_depth=3)

    if not urls_path:
        warn("Could not find your main urls.py automatically.")
        manual_path = prompts.prompt_django_urls_path()
        candidates = [
            os.path.join(cwd, manual_path),
            os.path.join(backend_root, manual_path),
        ]
        candidates = list(dict.fromkeys(candidates))
        urls_path = next((c for c in candidates if os.path.exists(c)), candidates[0])

    if urls_path and os.path.exists(urls_path):
        url_code = generator.generate_django_chat_url()
        url_result = writer.inject_django_url(urls_path, url_code)

        if url_result["success"]:
            success(f"Added BotVersion chat URL to {os.path.relpath(urls_path, cwd)}")
            changes["modified"].append(os.path.relpath(urls_path, cwd))
        elif url_result["reason"] == "already_exists":
            warn("BotVersion URL already found in urls.py — skipping.")
    else:
        warn("Could not find urls.py — add the chat URL manually:")
        changes["manual"].append(
            "Add to your main urls.py:\n\n"
            "    import botversion_sdk\n"
            "    from django.urls import path\n\n"
            "    urlpatterns += [\n"
            "        path('api/botversion/chat/', botversion_sdk.chat_handler('django')),\n"
            "    ]"
        )

    # ── Inject script tag into frontend file ──────────────────────────────────
    _inject_frontend_script_tag(detected, changes, cwd, args.force)


# ── Inject CORS settings into Django settings.py ─────────────────────────────

def _inject_cors_settings(detected, changes, cwd):
    """
    Automatically configures django-cors-headers in settings.py.
    So users don't need to manually set up CORS.
    """
    settings_info = detected.get("django_settings")
    if not settings_info:
        warn("Could not find settings.py — skipping CORS setup.")
        changes["manual"].append(
            "Add CORS configuration to your settings.py manually:\n\n"
            "    pip install django-cors-headers\n\n"
            "    INSTALLED_APPS += ['corsheaders']\n\n"
            "    MIDDLEWARE = ['corsheaders.middleware.CorsMiddleware'] + MIDDLEWARE\n\n"
            "    CORS_ALLOW_ALL_ORIGINS = True"
        )
        return

    settings_path = settings_info.get("path")

    try:
        with open(settings_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception:
        warn("Could not read settings.py — skipping CORS setup.")
        return

    # Already configured
    if "corsheaders" in content:
        info("CORS already configured in settings.py — skipping.")
        return

    backup = writer.backup_file(settings_path)
    if backup:
        changes["backups"].append(backup)

    # Step 1: Add corsheaders to INSTALLED_APPS
    result1 = writer.inject_into_installed_apps(settings_path, "corsheaders")

    # Step 2: Add CorsMiddleware to top of MIDDLEWARE
    result2 = writer.inject_into_middleware(
        settings_path,
        "corsheaders.middleware.CorsMiddleware"
    )

    # Step 3: Append CORS_ALLOW_ALL_ORIGINS to end of settings.py
    try:
        with open(settings_path, "r", encoding="utf-8") as f:
            current_content = f.read()
        if "CORS_ALLOW_ALL_ORIGINS" not in current_content:
            with open(settings_path, "a", encoding="utf-8") as f:
                f.write("\n# BotVersion — allow all origins for AI agent widget\nCORS_ALLOW_ALL_ORIGINS = True\n")
    except Exception:
        pass

    if result1.get("success") or result2.get("success"):
        success("Added CORS configuration to settings.py")
        changes["modified"].append(os.path.relpath(settings_path, cwd))
    else:
        warn("Could not auto-configure CORS — add manually:")
        changes["manual"].append(
            "Add to your settings.py:\n\n"
            "    INSTALLED_APPS += ['corsheaders']\n\n"
            "    MIDDLEWARE = ['corsheaders.middleware.CorsMiddleware'] + MIDDLEWARE\n\n"
            "    CORS_ALLOW_ALL_ORIGINS = True"
        )


# ── Inject frontend script tag ────────────────────────────────────────────────

def _inject_frontend_script_tag(detected, changes, cwd, force):
    """
    Injects the BotVersion script tag into the frontend HTML file.
    Called at the end of every framework setup function.
    """
    frontend_main_file = detected.get("frontend_main_file")
    project_info = detected.get("project_info")

    if not project_info:
        return

    script_tag = writer.generate_script_tag(project_info)

    if frontend_main_file:
        result = writer.inject_script_tag(
            frontend_main_file["file"],
            frontend_main_file["type"],
            script_tag,
            force,
        )

        rel_path = os.path.relpath(frontend_main_file["file"], cwd)

        if result["success"]:
            success(f"Injected script tag into {rel_path}")
            changes["modified"].append(rel_path)
            if result.get("backup"):
                changes["backups"].append(result["backup"])
        elif result["reason"] == "already_exists":
            warn("BotVersion script tag already exists — skipping.")
        else:
            warn("Could not auto-inject script tag. Add this manually to your HTML:")
            log()
            log(script_tag)
            log()
            changes["manual"].append(
                f"Add to your frontend HTML before </body>:\n\n{script_tag}"
            )
    else:
        warn("Could not find frontend HTML file automatically.")
        changes["manual"].append(
            f"Add to your frontend HTML before </body>:\n\n{script_tag}"
        )


# ── Handle missing run call ───────────────────────────────────────────────────

def _handle_missing_run_call(entry_point, init_block, imports, framework, changes, cwd, detected):
    warn("Could not find the right place to inject automatically.")
    response = prompts.prompt_missing_run_call(
        os.path.relpath(entry_point, cwd),
        framework,
    )

    if response["action"] == "append":
        full_block = (imports + "\n\n" + init_block) if imports else init_block
        result = writer.append_to_file(entry_point, full_block)
        if result["success"]:
            success("Appended BotVersion setup to end of file.")
            changes["modified"].append(os.path.relpath(entry_point, cwd))

    elif response["action"] == "manual_path":
        backend_root = detected.get("backend_root", cwd)
        candidates = [
            os.path.join(cwd, response["file_path"]),
            os.path.join(backend_root, response["file_path"]),
        ]
        candidates = list(dict.fromkeys(candidates))

        alt_path = next((c for c in candidates if os.path.exists(c)), None)

        if alt_path:
            full_block = (imports + "\n\n" + init_block) if imports else init_block
            result = writer.inject_before_run(alt_path, full_block, framework)
            if result["success"]:
                success(f"Injected into {response['file_path']}")
                changes["modified"].append(response["file_path"])
        else:
            error(f"File not found: {response['file_path']}")
            changes["manual"].append(
                f"Add this to your server file:\n{init_block}"
            )

    else:
        changes["manual"].append(
            f"Add this to your server file before starting the server:\n\n{init_block}"
        )
        warn("Skipped — see manual steps below.")


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\n  Aborted.")
        sys.exit(0)
    except Exception as e:
        print(f"\n  x  Unexpected error: {e}")
        if os.environ.get("DEBUG"):
            import traceback
            traceback.print_exc()
        sys.exit(1)