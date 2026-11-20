"""Chat backends, chosen per job (summaries, lab guides) in the settings.

Every client has  label  (what the generated files say wrote them),  check() -> (ok, message)  and
chat(system, user, temperature) -> text.  When check() fails the callers skip the generation and keep the
saved lesson: nothing breaks because a backend is down or not configured.

  ollama       a local Ollama server (native /api/chat, so the context window can be set)
  openai       any OpenAI-compatible /chat/completions API: Gemini, OpenAI and OpenRouter (built in), LM Studio...
  claude-code  the `claude` CLI, headless (claude -p): no tools, no session, an empty temporary folder
"""
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

from .config import ConfigError, Settings
from .ollama import OllamaClient

RETRY_STATUS = (429, 500, 502, 503, 504)  # rate limits and server hiccups (Gemini's free tier rate-limits often)


def _error_message(e: urllib.error.HTTPError) -> str:
    """The server's own explanation from an error body ({"error": {"message": ...}}, possibly in a list), else the raw start."""
    raw = e.read().decode("utf-8", "replace")
    try:
        data = json.loads(raw)
        data = data[0] if isinstance(data, list) and data else data
        return str(data["error"]["message"])
    except (ValueError, KeyError, TypeError, IndexError):
        return raw.strip()[:200] or e.reason


class OpenAIClient:
    def __init__(self, spec: dict, sleep=time.sleep):
        self.name, self.url, self.model = spec["name"], spec["url"].rstrip("/"), spec.get("model")
        self.key_env, self.key_required = spec["api_key_env"], bool(spec.get("key_required"))
        self.api_key = os.environ.get(self.key_env, "").strip().strip("'\"") or None  # only from the environment
        self.timeout, self.attempts, self._sleep = int(spec.get("timeout", 600)), 4, sleep

    @property
    def label(self) -> str:
        return f"{self.name}:{self.model}"

    def _headers(self) -> dict:
        headers = {"Content-Type": "application/json", "User-Agent": "mathesis"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    def check(self) -> tuple[bool, str]:
        if not self.model:
            return False, f"provider {self.name}: no model set (model = \"...\" in its [providers.{self.name}] table)"
        if self.key_required and not self.api_key:
            return False, (f"the API key is missing: export {self.key_env}=... in the shell that starts the server "
                           f"(provider {self.name})")
        try:
            req = urllib.request.Request(f"{self.url}/models", headers=self._headers())
            with urllib.request.urlopen(req, timeout=15):
                pass
        except urllib.error.HTTPError as e:
            if e.code in (400, 401, 403):  # Gemini answers an invalid key with 400
                return False, f"{self.name} rejected the request, probably the API key (HTTP {e.code}): {_error_message(e)}"
            # 404 / 405: a server without a model list is still a server
        except Exception as e:
            return False, f"cannot reach {self.name} at {self.url}: {e}"
        return True, f"{self.name} reachable, model {self.model}"

    def chat(self, system: str, user: str, temperature: float = 0.2) -> str:
        payload = {"model": self.model, "temperature": temperature,
                   "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
        for attempt in range(1, self.attempts + 1):
            req = urllib.request.Request(f"{self.url}/chat/completions", data=json.dumps(payload).encode(),
                                         headers=self._headers())
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    data = json.load(resp)
                break
            except urllib.error.HTTPError as e:
                if e.code in RETRY_STATUS and attempt < self.attempts:
                    self._sleep(min(2 ** attempt * 2, 60))
                    continue
                raise RuntimeError(f"{self.name} answered HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:300]}")
        try:
            text = (data["choices"][0]["message"]["content"] or "").strip()
        except (KeyError, IndexError, TypeError):
            raise RuntimeError(f"{self.name}: unexpected answer: {json.dumps(data)[:300]}")
        if not text:
            raise ValueError(f"{self.label} returned an empty answer")
        return text


# The only `gcloud` the model can reach when it may check commands: help pages. It runs with an empty CLOUDSDK_CONFIG (no account,
# no project, no credentials), so even a command that slipped past the allow rule could not touch a real project.
GCLOUD_SHIM = """#!/bin/sh
# Mathesis: `gcloud ... --help` only (read-only, offline, no credentials)
case " $* " in
  *" --help "*) exec "$REAL_GCLOUD" "$@" ;;
esac
echo "only 'gcloud ... --help' is available here" >&2
exit 2
"""


class ClaudeCodeClient:
    def __init__(self, spec: dict, run=subprocess.run, check_gcloud: bool = False):
        self.command, self.model, self.timeout, self._run = spec["command"], spec.get("model"), int(spec["timeout"]), run
        self.real_gcloud = shutil.which("gcloud") if check_gcloud else None
        self.checks_commands = bool(self.real_gcloud)   # the model may read `gcloud ... --help` before it writes a command

    @property
    def label(self) -> str:
        return "Claude Code" + (f" ({self.model})" if self.model else "") + (" + gcloud help" if self.checks_commands else "")

    def check(self) -> tuple[bool, str]:
        path = shutil.which(self.command)
        if not path:
            return False, f"the Claude Code CLI '{self.command}' was not found (set MATHESIS_CLAUDE)"
        return True, f"Claude Code CLI: {path}"

    def build_command(self, executable: str, system: str) -> list[str]:
        # no tools; or, to check commands, only Bash and only `gcloud <anything> --help` (anything else is refused, never asked)
        tools = (["--tools", "Bash", "--allowedTools", "Bash(gcloud * --help)", "--permission-mode", "dontAsk",
                  "--setting-sources", "project"] if self.checks_commands else ["--tools", ""])
        command = [executable, "-p", "--output-format", "text", *tools, "--no-session-persistence", "--system-prompt", system]
        return command + (["--model", self.model] if self.model else [])

    def _environment(self, scratch: str) -> dict | None:
        if not self.checks_commands:
            return None
        bin_dir = os.path.join(scratch, "bin")
        os.makedirs(bin_dir)
        shim = os.path.join(bin_dir, "gcloud")
        with open(shim, "w") as f:
            f.write(GCLOUD_SHIM)
        os.chmod(shim, 0o755)
        return {**os.environ, "PATH": bin_dir + os.pathsep + os.environ.get("PATH", ""), "REAL_GCLOUD": self.real_gcloud,
                "CLOUDSDK_CONFIG": os.path.join(scratch, "gcloud-config"), "CLOUDSDK_CORE_DISABLE_PROMPTS": "1",
                "CLOUDSDK_CORE_DISABLE_USAGE_REPORTING": "true", "CLOUDSDK_CORE_DISABLE_COLOR": "true"}

    def chat(self, system: str, user: str, temperature: float = 0.2) -> str:
        executable = shutil.which(self.command)
        if not executable:
            raise RuntimeError(self.check()[1])
        with tempfile.TemporaryDirectory(prefix="mathesis-claude-") as scratch:  # nothing of the project or the notes in reach
            extra = {"env": env} if (env := self._environment(scratch)) else {}
            done = self._run(self.build_command(executable, system), input=user, capture_output=True, text=True,
                             cwd=scratch, timeout=self.timeout, **extra)
        if done.returncode != 0:
            raise RuntimeError(f"claude exited with {done.returncode}: {(done.stderr or done.stdout).strip()[-300:]}")
        return done.stdout


def make_client(settings: Settings, role: str, run=subprocess.run):
    """The client for "summary", "lab_guide" or "domains"; None when that job's provider is "none". Raises ConfigError."""
    name, model = {"summary": (settings.summary_provider, settings.summary_model),
                   "lab_guide": (settings.lab_provider, settings.lab_model),
                   "domains": (settings.domains_provider, settings.domains_model)}[role]
    if name == "none":
        return None
    spec = settings.provider_spec(name, model)
    if spec["type"] == "ollama":
        return OllamaClient(settings, spec)
    if spec["type"] == "openai":
        return OpenAIClient(spec)
    return ClaudeCodeClient(spec, run, check_gcloud=role == "lab_guide" and settings.lab_check_commands)


_announced: dict[str, str] = {}


def should_announce(kind: str, problem: str | None) -> bool:
    """Notify once per outage: True the first time `problem` is seen for this kind of job; None = backend is fine again."""
    if problem is None:
        _announced.pop(kind, None)
        return False
    if _announced.get(kind) == problem:
        return False
    _announced[kind] = problem
    return True
