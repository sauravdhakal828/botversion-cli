"""
botversion-sdk-python/cli/prompts.py

Interactive CLI prompts — asks the user questions when things
can't be auto-detected.
Mirrors JS cli/prompts.js
"""


# ── Base prompt helpers ───────────────────────────────────────────────────────

def ask(question):
    """
    Asks a free-text question and returns the answer.
    Mirrors JS ask()
    """
    try:
        return input(question).strip()
    except (KeyboardInterrupt, EOFError):
        print("")
        raise SystemExit(0)


def ask_choice(question, choices):
    """
    Shows a numbered list and asks the user to pick one.
    Re-prompts if invalid input.
    Mirrors JS askChoice()
    """
    print(f"\n{question}")
    for i, choice in enumerate(choices):
        print(f"  {i + 1}. {choice['label']}")
    print("")

    while True:
        try:
            answer = input(f"Enter number (1-{len(choices)}): ").strip()
            num = int(answer)
            if 1 <= num <= len(choices):
                return choices[num - 1]
            else:
                print(f"  Please enter a number between 1 and {len(choices)}")
        except ValueError:
            print(f"  Please enter a number between 1 and {len(choices)}")
        except (KeyboardInterrupt, EOFError):
            print("")
            raise SystemExit(0)


def confirm(question, default_yes=True):
    """
    Asks a yes/no question.
    Mirrors JS confirm()
    """
    hint = "[Y/n]" if default_yes else "[y/N]"
    answer = ask(f"{question} {hint}: ")
    if not answer:
        return default_yes
    return answer.lower().startswith("y")


# ── Specific prompts ──────────────────────────────────────────────────────────

def prompt_entry_point():
    """
    Asks user to manually enter their server file path.
    Mirrors JS promptEntryPoint()
    """
    print("\n  ⚠  We couldn't find your server entry point automatically.")
    return ask("  Enter the path to your main server file (e.g. app.py or src/main.py): ")


def prompt_auth_library(framework):
    """
    Shows list of supported Python auth libraries to pick from.
    Mirrors JS promptAuthLibrary()
    """
    # Common choices per framework
    if framework == "flask":
        choices = [
            {"label": "Flask-Login", "value": {"name": "flask_login", "supported": True}},
            {"label": "Flask-JWT-Extended", "value": {"name": "flask_jwt_extended", "supported": True}},
            {"label": "Other / Custom", "value": {"name": "custom", "supported": False}},
            {"label": "No auth", "value": {"name": None, "supported": False}},
        ]
    elif framework == "fastapi":
        choices = [
            {"label": "FastAPI Users", "value": {"name": "fastapi_users", "supported": True}},
            {"label": "python-jose (JWT)", "value": {"name": "python_jose", "supported": True}},
            {"label": "Other / Custom", "value": {"name": "custom", "supported": False}},
            {"label": "No auth", "value": {"name": None, "supported": False}},
        ]
    elif framework == "django":
        choices = [
            {"label": "Django built-in auth", "value": {"name": "django_allauth", "supported": True}},
            {"label": "Django REST Framework", "value": {"name": "django_rest_framework", "supported": True}},
            {"label": "djangorestframework-simplejwt", "value": {"name": "djangorestframework_simplejwt", "supported": True}},
            {"label": "Other / Custom", "value": {"name": "custom", "supported": False}},
            {"label": "No auth", "value": {"name": None, "supported": False}},
        ]
    else:
        choices = [
            {"label": "Other / Custom", "value": {"name": "custom", "supported": False}},
            {"label": "No auth", "value": {"name": None, "supported": False}},
        ]

    choice = ask_choice(
        "We couldn't detect your auth library. Which one are you using?",
        choices,
    )
    return choice["value"]


def prompt_missing_run_call(entry_point, framework):
    """
    Asks what to do when app.run() / uvicorn.run() can't be found.
    Mirrors JS promptMissingListenCall()
    """
    run_calls = {
        "flask": "app.run()",
        "fastapi": "uvicorn.run()",
        "django": "application = get_wsgi_application()",
    }
    run_call = run_calls.get(framework, "server start call")

    print(f"\n  ⚠  We couldn't find {run_call} in {entry_point}")
    print("  Options:")

    choices = [
        {"label": "Append to end of file", "value": "append"},
        {"label": "Enter the correct file path manually", "value": "manual_path"},
        {"label": "Skip — I'll add it manually", "value": "skip"},
    ]

    choice = ask_choice("How would you like to proceed?", choices)

    if choice["value"] == "manual_path":
        file_path = ask("  Enter file path: ")
        return {"action": "manual_path", "file_path": file_path}

    return {"action": choice["value"]}


def prompt_force(conflict_file):
    """
    Asks if user wants to overwrite an existing file.
    Mirrors JS promptForce()
    """
    print(f"\n  ⚠  File already exists: {conflict_file}")
    return confirm("  Overwrite it? (a backup will be created)", default_yes=False)


def prompt_django_settings_path():
    """
    Asks for the Django settings file path when auto-detection fails.
    """
    print("\n  ⚠  We couldn't find your Django settings file automatically.")
    return ask("  Enter the path to your settings file (e.g. config/settings.py): ")


def prompt_django_urls_path():
    """
    Asks for the Django urls.py path when auto-detection fails.
    """
    print("\n  ⚠  We couldn't find your main urls.py automatically.")
    return ask("  Enter the path to your main urls.py (e.g. myproject/urls.py): ")