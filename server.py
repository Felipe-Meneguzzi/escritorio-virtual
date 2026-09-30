#!/usr/bin/env python3
"""Escritório — um escritório 3D estilo "The Office" no navegador; cada sala é um projeto (pasta) e os
funcionários são instâncias do Claude Code.

Uso:
    python3 server.py                         # raiz = ~/escritorios, porta 8766, abre o navegador do Windows
    python3 server.py --root /tmp/x --port 8776 --no-open
    ESC_ROOT=/tmp/x python3 server.py         # mesma coisa que --root
    ESC_DRY_RUN=1 python3 server.py           # não abre app do Windows, só loga o comando

Rotas do núcleo aqui; rotas extras vêm de features/*.py (ver ARCH.md).
Segurança: só escuta em 127.0.0.1; toda requisição confere o Host; toda rota /api/* exige Origin igual (ou
ausente), Sec-Fetch-Site não cross-site e o cabeçalho X-Esc: 1 (anti-CSRF: força preflight entre origens).
"""
import argparse
import base64
import fcntl
import hashlib
import json
import mimetypes
import os
import re
import select
import shutil
import socket
import stat
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import esc_core as core
import features

VERSION = "0.1.0"
FEATURE_ROUTES = {}    # (MÉTODO, caminho) -> handler(ctx, query)
FEATURE_PATTERNS = []  # (MÉTODO, regex, handler, modelo) — '/api/x/{id}/acao' → ctx.params
LOADED_FEATURES = []

CLIENT_GONE = (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)
HUB_NAME = re.compile(r"^[^\x00-\x1f\x7f]{1,200}$")   # nomes de canal podem ter o id do escritório (acentos, espaços)
HUB_MAX_WAIT = 25
CSRF_HEADER = "X-Esc"

JS_MIME = {".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
           ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
           ".map": "application/json; charset=utf-8", ".html": "text/html; charset=utf-8",
           ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2"}
# conteúdo do usuário servido cru (imagens das salas): sandbox + default-src 'none'
RAW_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox"


THREE_CDN = "https://cdn.jsdelivr.net/npm/three@0.160.0/"     # prefixo de caminho (CSP aceita) — muda junto com o importmap


def index_csp(html: bytes) -> str:
    """CSP do index: scripts só da mesma origem + o CAMINHO EXATO do three@0.160.0 no jsdelivr (o domínio inteiro
    serviria JS de qualquer repositório/pacote: cdn.jsdelivr.net/gh/<quem>/<repo>/x.js) + o hash do importmap inline.
    Sem frames/workers de fora (frame-src/child-src 'none'): um <iframe srcdoc> injetado não carrega nada. O importmap
    ainda leva "integrity" (SRI) dos dois arquivos do three usados."""
    hashes = []
    for m in re.finditer(rb"<script type=\"importmap\">(.*?)</script>", html, re.S):
        hashes.append("'sha256-" + base64.b64encode(hashlib.sha256(m.group(1)).digest()).decode() + "'")
    return ("default-src 'self'; script-src 'self' " + THREE_CDN + " " + " ".join(hashes) + "; "
            "style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; "
            "font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; "
            "frame-src 'none'; child-src 'none'; worker-src 'self'")


class Ctx:
    """O que um handler de feature recebe além da query."""

    def __init__(self, handler: "Handler", method: str, path: str, query: dict):
        self.handler = handler
        self.method = method
        self.path = path
        self.query = query
        self.params = {}
        self.headers = handler.headers
        self._body = None
        self._json = None

    def body(self) -> bytes:
        if self._body is None:
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                raise core.HttpError(400, "Content-Length inválido") from None
            if n > core.MAX_BODY:
                raise core.HttpError(413, "corpo grande demais")
            self._body = self.handler.rfile.read(n) if n > 0 else b""
        return self._body

    def json(self) -> dict:
        """Corpo como JSON ({} se vazio); inválido → 400. Sempre dict."""
        if self._json is None:
            raw = self.body()
            if not raw:
                self._json = {}
            else:
                try:
                    self._json = json.loads(raw)
                except ValueError as e:
                    raise core.HttpError(400, f"JSON inválido: {e}") from e
                if not isinstance(self._json, dict):
                    raise core.HttpError(400, "o corpo precisa ser um objeto JSON")
        return self._json

    def office_id(self) -> str:
        """?office= da query, ou "office" do corpo JSON (POST/PUT)."""
        oid = self.query.get("office")
        if not oid and self.method in ("POST", "PUT", "PATCH", "DELETE"):
            oid = self.json().get("office")
        if not oid:
            raise core.HttpError(400, "falta o parâmetro office")
        return oid

    def office_dir(self) -> str:
        """Caminho real validado do escritório do pedido (404 se não existe)."""
        return core.office_dir(self.office_id())

    def client_gone(self) -> bool:
        sock = self.handler.connection
        try:
            r, _, _ = select.select([sock], [], [], 0)
            if not r:
                return False
            return sock.recv(1, socket.MSG_PEEK) == b""
        except (OSError, ValueError):
            return True

    def wait_for(self, pred, timeout: float, interval: float = 0.5):
        end = time.monotonic() + max(0.0, timeout)
        val = pred()
        while not val:
            left = end - time.monotonic()
            if left <= 0 or self.client_gone():
                break
            time.sleep(min(interval, left))
            val = pred()
        return val


class Handler(BaseHTTPRequestHandler):
    server_version = "Escritorio/" + VERSION
    timeout = 120

    def log_message(self, fmt, *args):
        if "--verbose" in sys.argv:
            super().log_message(fmt, *args)

    def host_ok(self) -> bool:
        host = (self.headers.get("Host") or "").lower()
        port = core.PORT
        return host in {f"localhost:{port}", f"127.0.0.1:{port}", f"[::1]:{port}"}

    def csrf_error(self):
        port = core.PORT
        origin = self.headers.get("Origin")
        allowed = {f"http://localhost:{port}", f"http://127.0.0.1:{port}", f"http://[::1]:{port}"}
        if origin is not None and origin.lower() not in allowed:   # inclui Origin: null
            return "origem não permitida"
        if (self.headers.get("Sec-Fetch-Site") or "").lower() in ("cross-site", "same-site"):
            return "pedido de outro site"
        if self.headers.get(CSRF_HEADER) != "1":   # TODA rota /api/ (inclusive GET que lê conteúdo)
            return f"falta o cabeçalho {CSRF_HEADER}: 1"
        return None

    def _common_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")

    def send_json(self, data, code=200):
        body = core.json_bytes(data)
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._common_headers()
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_bytes(self, resp: core.Response):
        self.send_response(resp.status)
        self.send_header("Content-Type", resp.content_type)
        self.send_header("Content-Length", str(len(resp.body)))
        self._common_headers()
        for k, v in resp.headers.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(resp.body)

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_PUT(self):
        self.route("PUT")

    def do_PATCH(self):
        self.route("PATCH")

    def do_DELETE(self):
        self.route("DELETE")

    # ---------------------------------------------------------------- rotas do núcleo
    def api_status(self, ctx, q):
        return {"ok": True, "app": "escritorio", "version": VERSION, "boot": core.BOOT_ID, "root": str(core.root_real()),
                "port": core.PORT, "dry_run": core.dry_run(), "features": LOADED_FEATURES,
                "limits": {"max_func": core.MAX_FUNC, "clone_max": core.CLONE_MAX, "note_max": core.NOTE_MAX}}

    def api_offices(self, ctx, q):
        """GET /api/office → {root, offices:[{id,name,created,has_meta}]} (vazio = primeiro acesso)."""
        return {"root": str(core.root_real()), "offices": core.list_offices()}

    def api_office_create(self, ctx, q):
        """POST /api/office {name} → 201 {id, name, path}; 409 {error, id} se já existe; 400 nome inválido."""
        name = ctx.json().get("name")
        if not isinstance(name, str) or not name.strip():
            raise core.HttpError(400, "diga o nome do escritório")
        if len(name) > 200:
            raise core.HttpError(400, "nome longo demais")
        return core.create_office(name), 201

    def api_office_name(self, ctx, q):
        """GET /api/office-name?name= → {folder} — pré-visualização do nome da pasta (400 se inválido)."""
        folder = core.sanitize_name(q.get("name") or "")
        exists = any(o["id"].lower() == folder.lower() for o in core.list_offices())
        return {"folder": folder, "exists": exists, "path": os.path.join(str(core.root_real()), folder)}

    def api_office_get(self, ctx, q):
        """GET /api/office/{office} → {id, name, path, created, rooms, quadro_count, limits, ...enrichers}."""
        oid = ctx.params["office"]
        od = core.office_dir(oid)
        m = core.read_meta(od)
        rooms = core.list_rooms(oid)
        try:
            quadro_count = sum(1 for n in os.listdir(os.path.join(od, core.QUADRO))
                               if n.endswith(".md") and not n.startswith("."))
        except OSError:
            quadro_count = 0
        data = {"id": oid, "name": m.get("name") or oid, "path": od, "created": m.get("created"), "rooms": rooms,
                "clones": [], "quadro_count": quadro_count,
                "limits": {"max_employees": core.MAX_FUNC, "clone_max": core.CLONE_MAX, "note_max": core.NOTE_MAX}}
        for fn in core.OFFICE_ENRICHERS:
            try:
                fn(oid, od, data)
            except Exception as e:  # noqa: BLE001
                core.log(f"[esc] office enricher {getattr(fn, '__module__', '?')} falhou: {e!r}")
        return data

    def api_rooms(self, ctx, q):
        """GET /api/rooms?office= → {rooms:[ROOM], etag}."""
        rooms = core.list_rooms(ctx.office_id())
        etag = hashlib.sha1(core.json_bytes(rooms)).hexdigest()[:16]
        return {"rooms": rooms, "etag": etag}

    def api_hub(self, ctx, q):
        """GET /api/hub?since={"canal": versão}&wait=<s ≤ 25> → {versions, boot, waited} (igual ao Arquipélago)."""
        try:
            since = json.loads(q.get("since") or "{}")
        except ValueError as e:
            raise core.HttpError(400, f"since inválido: {e}") from e
        if not isinstance(since, dict) or len(since) > 32 or not all(isinstance(k, str) and HUB_NAME.match(k) for k in since):
            raise core.HttpError(400, "since: objeto {canal: versão} com até 32 nomes")
        wait = core.clamp_wait(q.get("wait"), HUB_MAX_WAIT)
        with core.longpoll_slot("hub", 12) as ok:
            if ok and wait > 0:
                versions = core.hub_wait(since, wait, gone=ctx.client_gone)
            else:
                versions = core.hub_versions(since.keys())
        return {"versions": versions, "boot": core.BOOT_ID, "waited": bool(ok and wait > 0)}

    CORE_ROUTES = {
        ("GET", "/api/status"): api_status,
        ("GET", "/api/office"): api_offices,
        ("POST", "/api/office"): api_office_create,
        ("GET", "/api/office-name"): api_office_name,
        ("GET", "/api/rooms"): api_rooms,
        ("GET", "/api/hub"): api_hub,
    }
    CORE_PATTERNS = [("GET", "/api/office/{office}", api_office_get)]

    # ---------------------------------------------------------------- roteamento
    def route(self, method):
        if not self.host_ok():
            return self.send_json({"error": "host não permitido"}, 403)
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            if not url.path.startswith("/api/"):
                if method != "GET":
                    return self.send_json({"error": "método não permitido"}, 405)
                if url.path in ("/", "/index.html"):
                    return self.serve_index()
                if url.path.startswith("/js/"):
                    return self.serve_static_js(url.path)
                if url.path == "/favicon.ico":
                    return self.serve_favicon()
                return self.send_json({"error": "rota não encontrada"}, 404)
            err = self.csrf_error()
            if err:
                return self.send_json({"error": err}, 403)
            key = (method, url.path)
            if key in self.CORE_ROUTES:
                return self.run(lambda ctx, qq: self.CORE_ROUTES[key](self, ctx, qq), method, url.path, q)
            if key in FEATURE_ROUTES:
                return self.run(FEATURE_ROUTES[key], method, url.path, q)
            other_method = False
            for m, rx, fn, _tpl in PATTERNS:
                hit = rx.match(url.path)
                if hit:
                    if m == method:
                        params = {k: unquote(v) for k, v in hit.groupdict().items()}
                        return self.run(fn, method, url.path, q, params)
                    other_method = True
            known = {p for _, p in self.CORE_ROUTES} | {p for _, p in FEATURE_ROUTES}
            if url.path in known or other_method:
                return self.send_json({"error": "método não permitido"}, 405)
            return self.send_json({"error": "rota não encontrada"}, 404)
        except CLIENT_GONE:
            self.close_connection = True
        except core.HttpError as e:
            return self.send_json({"error": e.msg, **e.extra}, e.status)
        except PermissionError as e:
            return self.send_json({"error": f"sem permissão: {e}"}, 403)
        except FileNotFoundError:
            return self.send_json({"error": "não encontrado"}, 404)
        except (KeyError, NotADirectoryError, ValueError) as e:
            return self.send_json({"error": f"requisição inválida: {e}"}, 400)
        except Exception as e:  # noqa: BLE001
            core.log(f"[esc] erro em {method} {url.path}: {e!r}")
            return self.send_json({"error": str(e)}, 500)

    def run(self, fn, method, path, q, params=None):
        ctx = Ctx(self, method, path, q)
        if params:
            ctx.params = params
        out = fn(ctx, q)
        if isinstance(out, core.Response):
            return self.send_bytes(out)
        if isinstance(out, tuple) and len(out) == 2 and isinstance(out[1], int):   # (dados, status)
            return self.send_json(out[0], out[1])
        return self.send_json({"ok": True} if out is None else out)

    # ---------------------------------------------------------------- estáticos
    def serve_index(self):
        html = (core.HERE / "index.html").read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(html)))
        self.send_header("Content-Security-Policy", index_csp(html))
        self._common_headers()
        self.end_headers()
        self.wfile.write(html)

    def serve_favicon(self):
        svg = (b"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect x='2' y='3' width='12' height='11'"
               b" rx='1' fill='#1f3a5f'/><rect x='4' y='5' width='8' height='2' fill='#f3ead3'/><rect x='4' y='9'"
               b" width='5' height='2' fill='#d9a441'/></svg>")
        return self.send_bytes(core.Response(svg, "image/svg+xml"))

    def serve_static_js(self, raw_path: str):
        rel = unquote(raw_path)[len("/js/"):]
        if "\x00" in rel or "\\" in rel:
            return self.send_json({"error": "rota não encontrada"}, 404)
        base = str(core.JS_DIR)
        full = os.path.normpath(os.path.join(base, rel))
        if os.path.commonpath([full, base]) != base or not os.path.isfile(full):
            return self.send_json({"error": "rota não encontrada"}, 404)
        real = os.path.realpath(full)
        if os.path.commonpath([real, os.path.realpath(base)]) != os.path.realpath(base):
            return self.send_json({"error": "rota não encontrada"}, 404)
        ext = os.path.splitext(full)[1].lower()
        mime = JS_MIME.get(ext) or mimetypes.guess_type(full)[0] or "application/octet-stream"
        return self.serve_file(Path(full), mime)

    def serve_file(self, path: Path, mime: str, headers=None):
        st = path.stat()
        if not stat.S_ISREG(st.st_mode) or st.st_size > core.MAX_RAW:
            return self.send_json({"error": "arquivo inválido"}, 400)
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(st.st_size))
        self._common_headers()
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        with open(path, "rb") as f:
            shutil.copyfileobj(f, self.wfile)


PATTERNS = []   # (MÉTODO, regex, fn(ctx, q), modelo) — núcleo + features


def _compile_pattern(path: str):
    return re.compile("^" + re.sub(r"\\\{([A-Za-z_]\w*)\\\}", r"(?P<\1>[^/]+)", re.escape(path)) + "$")


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 64
    allow_reuse_address = True

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, CLIENT_GONE + (TimeoutError, socket.timeout)):
            return
        super().handle_error(request, client_address)


def load_features() -> None:
    for m, path, fn in Handler.CORE_PATTERNS:
        PATTERNS.append((m, _compile_pattern(path), (lambda f: lambda ctx, q: f(HANDLER_SELF, ctx, q))(fn), path))
    routes, office_enrichers, loaded, failed = features.load_all()
    for key, fn in routes.items():
        if key in Handler.CORE_ROUTES:
            core.log(f"[esc] rota {key} de feature ignorada: é do núcleo")
            continue
        method, path = key
        if "{" in path:
            PATTERNS.append((method, _compile_pattern(path), fn, path))
        else:
            FEATURE_ROUTES[key] = fn
    core.OFFICE_ENRICHERS[:] = office_enrichers
    LOADED_FEATURES[:] = loaded
    print(f"   features: {', '.join(loaded) or 'nenhuma'} ({len(FEATURE_ROUTES) + len(PATTERNS) - len(Handler.CORE_PATTERNS)} rotas)"
          + (f" · falharam: {', '.join(failed)}" if failed else ""), flush=True)


class _Self:
    """Os handlers de padrão do núcleo não usam `self` (só ctx); este objeto ocupa o lugar."""


HANDLER_SELF = _Self()


def _register_channels():
    def rooms_factory(name):
        oid = name[len("esc:rooms:"):]
        try:
            core.office_dir(oid)
        except core.HttpError:
            return None
        return lambda: core.rooms_probe_value(oid)
    core.channel_prefix("esc:rooms:", rooms_factory, interval=1.5)


def lock_root(root: str):
    """Um servidor por raiz: flock em <raiz>/.escritorio-server.lock (liberado quando o processo morre)."""
    os.makedirs(root, exist_ok=True)
    fd = os.open(os.path.join(root, ".escritorio-server.lock"), os.O_RDWR | os.O_CREAT, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print(f"✋ Já tem outro servidor do Escritório usando {root}. Feche-o antes (ou use outra --root).", flush=True)
        sys.exit(1)
    os.ftruncate(fd, 0)
    os.write(fd, f"{os.getpid()}\n".encode())
    return fd


def open_browser(url: str) -> None:
    try:
        if shutil.which("wslview") and not core.dry_run():
            subprocess.Popen(["wslview", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif shutil.which("explorer.exe") or core.dry_run():
            core.run_windows("explorer.exe", url)
        elif shutil.which("xdg-open"):                       # Linux com desktop
            subprocess.Popen(["xdg-open", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif shutil.which("open"):                           # macOS
            subprocess.Popen(["open", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError as e:
        print(f"   (não consegui abrir o navegador sozinho: {e} — abra a URL acima na mão)", flush=True)


def main():
    ap = argparse.ArgumentParser(description="Escritório 3D: salas = projetos, funcionários = Claude Code")
    ap.add_argument("--root", default=os.environ.get("ESC_ROOT") or str(Path.home() / "escritorios"),
                    help="raiz dos escritórios (padrão: ~/escritorios ou $ESC_ROOT)")
    ap.add_argument("--port", type=int, default=int(os.environ.get("ESC_PORT") or 8766))
    ap.add_argument("--no-open", action="store_true", help="não abrir o navegador")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    root = os.path.normpath(os.path.abspath(os.path.expanduser(args.root)))
    os.makedirs(root, exist_ok=True)
    core.ROOT = Path(root)
    core.ROOT_REAL = os.path.realpath(root)
    core.PORT = args.port
    _lock_fd = lock_root(core.ROOT_REAL)  # noqa: F841 — segura o flock até o fim do processo
    srv = Server(("127.0.0.1", core.PORT), Handler)
    url = f"http://localhost:{core.PORT}/"
    print(f"🏢 Escritório abrindo as portas em {core.ROOT_REAL}", flush=True)
    print(f"   {url}  (Ctrl+C para fechar o expediente)" + ("  [ESC_DRY_RUN]" if core.dry_run() else ""), flush=True)
    _register_channels()
    load_features()
    if not args.no_open:
        open_browser(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n🌙 expediente encerrado.", flush=True)
    finally:
        srv.server_close()
        features.run_exit_hooks()


if __name__ == "__main__":
    main()
