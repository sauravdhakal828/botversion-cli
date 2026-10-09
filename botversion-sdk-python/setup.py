from setuptools import setup, find_packages

setup(
    name="botversion-sdk",
    version="2.2.2",
    description="BotVersion SDK — automatically discover and register your API endpoints",
    long_description=open("README.md").read() if __import__("os").path.exists("README.md") else "",
    long_description_content_type="text/markdown",
    author="BotVersion",
    author_email="support@botversion.com",
    url="https://github.com/botversion/botversion-sdk-python",
    packages=find_packages(),
    python_requires=">=3.7",

    entry_points={
        "console_scripts": [
            "botversion-scan-endpoints=botversion_sdk.bin.scan_endpoints:main",
        ],
    },

    # python-dotenv is the only hard dependency, used to auto-load .env /
    # .env.local for the build-time CLI scanner (see bin/scan_endpoints.py).
    # FastAPI, Flask, Django, etc. are optional — detected at runtime, not
    # required to install the SDK itself.
    install_requires=[
        "python-dotenv>=1.0.0",
    ],

    extras_require={
        "fastapi": ["fastapi", "starlette"],
        "flask": ["flask"],
        "django": ["django"],
    },

    classifiers=[
        "Programming Language :: Python :: 3",
        "License :: OSI Approved :: MIT License",
        "Operating System :: OS Independent",
        "Intended Audience :: Developers",
        "Topic :: Software Development :: Libraries",
    ],

    keywords=["botversion", "api", "sdk", "fastapi", "flask", "django"],
)