"""Minimal Ollama client (native /api/chat, so the context window can be set)."""
import json
import urllib.request

from .config import Settings


class OllamaClient:
    def __init__(self, settings: Settings, spec: dict | None = None):
        spec = spec or {}  # a provider table (several Ollama servers / models can be configured); default: the settings
        self.url = str(spec.get("url", settings.ollama_url)).rstrip("/")
        self.model = spec.get("model") or settings.model
        self.num_ctx = int(spec.get("num_ctx", settings.num_ctx))
        self.embed_model = settings.embed_model

    @property
    def label(self) -> str:
        return self.model

    def check(self) -> tuple[bool, str]:
        return self.check_model()

    def installed_models(self) -> list[str]:
        with urllib.request.urlopen(f"{self.url}/api/tags", timeout=10) as resp:
            return [m["name"] for m in json.load(resp)["models"]]

    def check_model(self) -> tuple[bool, str]:
        """Is the configured model installed? Returns (ok, message)."""
        try:
            names = self.installed_models()
        except Exception as e:
            return False, f"cannot reach Ollama at {self.url}: {e}"
        if self.model not in names:
            return False, f"model {self.model!r} is not installed. Installed: {', '.join(names)}"
        return True, f"model {self.model} is installed"

    def embed(self, texts: list[str], model: str | None = None) -> list[list[float]]:
        """Embeddings for a batch of texts (default: the configured embedding model)."""
        payload = {"model": model or self.embed_model, "input": texts}
        req = urllib.request.Request(f"{self.url}/api/embed", data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=300) as resp:
            return json.load(resp)["embeddings"]

    def chat(self, system: str, user: str, temperature: float = 0.2) -> str:
        """One chat call. Raises if Ollama answers with a different model than the configured one."""
        payload = {
            "model": self.model, "stream": False,
            "think": False,  # skip reasoning output on models that support it
            "options": {"temperature": temperature, "num_ctx": self.num_ctx},
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        }
        req = urllib.request.Request(f"{self.url}/api/chat", data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=900) as resp:
            data = json.load(resp)
        if data.get("model") != self.model:
            raise RuntimeError(f"wrong model answered: asked {self.model!r}, got {data.get('model')!r}")
        text = data["message"]["content"].strip()
        if not text:
            raise ValueError(f"{self.model} returned an empty answer")
        return text
