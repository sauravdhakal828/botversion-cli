# botversion-sdk-python/setup.py
from setuptools import setup, find_packages

setup(
    name="botversion-sdk",
    version="1.0.0",
    description="BotVersion SDK — automatically discover and register your API endpoints",
    long_description=open("README.md").read(),
    long_description_content_type="text/markdown",
    author="BotVersion",
    author_email="support@botversion.com",
    url="https://github.com/botversion/botversion-sdk-python",
    packages=find_packages(),
    python_requires=">=3.7",

    # No required dependencies — works with stdlib only.
    # FastAPI, Flask, Django are optional — detected at runtime.
    install_requires=[],

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