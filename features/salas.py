"""PACOTE salas — backend de SALAS/PROJETOS.

Cada sala é uma subpasta real do escritório (o núcleo lista em core.list_rooms). Este módulo:
  POST /api/rooms {office, name, description?, git_init?:true}      → 201 {room, git_ok}      (sala do zero)
  POST /api/rooms/clone {office, url, name?}                         → 202 CLONE · 400 · 429   (git clone)
  GET  /api/rooms/clones?office=[&wait&etag]                         → {clones:[CLONE], etag}  (long-poll)
  GET  /api/rooms/clones/{id}                                        → CLONE
  POST /api/rooms/clones/{id}/cancel                                 → {ok}
  PATCH /api/rooms/{room}?office= {display?, color?, order?}         → ROOM  (só metadados; a pasta nunca muda)
  GET  /api/rooms/{room}/files?office=&path=&offset=&limit=&all=     → listagem de UMA pasta (paginada)
  GET  /api/rooms/{room}/summary?office=                             → números para a arte diegética
  GET  /api/rooms/{room}/file?office=&path=                          → leitura (≤ 200 KB) com detecção de binário
  GET  /api/rooms/{room}/raw?office=&path=                           → bytes de IMAGEM (CSP sandbox)
  GET  /api/rooms/{room}/git?office=                                 → status barato (cache 5 s; config lida pelo próprio git, filtros neutralizados)
  GET  /api/rooms/overview?office=[&room=&fresh=1]                   → {rooms:{id:{summary, top, git}}} (extra: 1 pedido
                                                                        para todas as placas/gaveteiros do prédio)
Canais do hub: esc:clones (Notifier) e esc:sala:<office>/<sala> (sondado: nomes/mtimes do 1º nível + .git/index).
Renomear pasta / apagar sala: fora de escopo de propósito (evita perder projeto).
CONTRATO: ARCH.md §Salas.
"""
import base64
import ipaddress
import mimetypes
import os
import re
import secrets
import shutil
import signal
import socket
import subprocess
import threading
import time
import unicodedata
from urllib.parse import unquote

import esc_core as core

IGNORED_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache", ".ruff_cache",
                ".next", ".nuxt", "dist", "build", "target", ".gradle", ".idea", ".dart_tool", "vendor", ".cache",
                ".tox", "coverage", ".terraform", ".parcel-cache", ".turbo", ".svelte-kit"}
READ_MAX = 200_000          # bytes lidos de um arquivo de texto
LIST_MAX = 300              # entradas por página
SCAN_MAX = 5000             # entradas lidas de uma pasta (pasta gigante vira "truncated")
RAW_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox"
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
CLONE_ID_RE = re.compile(r"^c\d{14}[0-9a-f]{4}$")
GIT_TTL = 5.0
SUMMARY_TTL = 60.0


def _now():
    return time.time()


def _shown(text, fallback=""):
    """Nome exibido: NFC, sem caracteres de controle/formato, espaços colapsados, ≤ 60."""
    s = unicodedata.normalize("NFC", text or "")
    s = "".join(ch for ch in s if unicodedata.category(ch)[0] != "C")
    s = " ".join(s.split())[:core.NAME_MAX_CHARS].strip()
    return s or fallback


def _room_view(office_id, folder):
    for r in core.list_rooms(office_id):
        if r["id"] == folder:
            return r
    raise core.HttpError(404, "sala não existe")


# ============================================================ sala do zero
def create_room(ctx, q):
    """POST /api/rooms {office, name, description?, git_init?:true} → 201 {room, git_ok}."""
    body = ctx.json()
    oid = ctx.office_id()
    od = core.office_dir(oid)
    name = body.get("name")
    if not isinstance(name, str) or not name.strip():
        raise core.HttpError(400, "diga o nome da sala (projeto)")
    if len(name) > 200:
        raise core.HttpError(400, "nome longo demais")
    desc = body.get("description") or ""
    if not isinstance(desc, str) or len(desc) > 4000:
        raise core.HttpError(400, "descrição inválida (até 4000 caracteres)")
    git_init = body.get("git_init", True) is not False
    base = core.sanitize_name(name)
    display = _shown(name, base)
    with core.office_lock(od):
        for _ in range(5):
            folder = core.unique_dir_name(od, base, _pending_names(od))
            p = os.path.join(od, folder)
            try:
                os.mkdir(p, 0o755)
                break
            except FileExistsError:
                continue
        else:
            raise core.HttpError(409, "não consegui reservar o nome da pasta")
    readme = f"# {display}\n\n{desc.strip() or 'Projeto criado no escritório.'}\n"
    core.atomic_write(os.path.join(p, "README.md"), readme.encode())
    git_ok = None
    if git_init:
        try:
            r = subprocess.run(["git", *core.GIT_SAFE, "init", "-q", "-b", "main", "--template=", "--", p],
                               env=core.GIT_ENV, capture_output=True, timeout=15, stdin=subprocess.DEVNULL)
            git_ok = r.returncode == 0
            if not git_ok:
                core.log(f"[salas] git init falhou em {p}: {r.stderr.decode('utf-8', 'replace')[-300:]}")
        except (OSError, subprocess.TimeoutExpired) as e:
            core.log(f"[salas] git init falhou em {p}: {e!r}")
            git_ok = False
    core.register_room(od, folder, display, {"kind": "zero"})
    return {"room": _room_view(oid, folder), "git_ok": git_ok}, 201


# ============================================================ clone
# https://[cred@]host[:porta]/caminho  |  ssh://[user@]host[:porta]/caminho  |  user@host:caminho (scp)
_HOST = r"[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?"
_PATH = r"[A-Za-z0-9._~/%+-]+"
RE_HTTPS = re.compile(rf"^https://(?:([A-Za-z0-9._~%-]+)(?::([^@/\s]*))?@)?({_HOST})(?::(\d{{1,5}}))?/({_PATH})$")
RE_SSH = re.compile(rf"^ssh://(?:([A-Za-z0-9._-]+)@)?({_HOST})(?::(\d{{1,5}}))?/({_PATH})$")
RE_SCP = re.compile(rf"^([A-Za-z0-9._-]+)@({_HOST}):((?!/)[A-Za-z0-9._~/%+-]+)$")
BLOCK_HOSTS = re.compile(r"^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1|"
                         r"\d+$|.*\.local$|.*\.internal$|.*\.localhost$)", re.I)
_CRED = re.compile(r"(://)[^/@\s]+@")
_CRED_HTTPS = re.compile(r"^(https://)[^/@\s]+@")      # só https leva senha/token; em ssh o usuário é necessário


def validate_clone_url(url) -> dict:
    """Recusa ANTES de rodar qualquer coisa. Devolve {url, kind, host, name (sugestão), display_url (sem credencial)}."""
    if not isinstance(url, str):
        raise core.HttpError(400, "URL inválida")
    url = url.strip()
    if not url:
        raise core.HttpError(400, "cole a URL do repositório")
    if len(url) > 500 or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in url):
        raise core.HttpError(400, "URL inválida (espaços ou caracteres de controle)")
    if url.startswith("-"):
        raise core.HttpError(400, "a URL não pode começar com '-'")
    if "::" in url.split("/")[0] or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*::", url):
        raise core.HttpError(400, "transporte remoto 'x::' não é permitido")
    if ".." in re.split(r"[/:]", url.split("?")[0]):
        raise core.HttpError(400, "caminho com '..' não é permitido")
    m = RE_HTTPS.match(url)
    auth = None
    if m:
        kind, host, path = "https", m.group(3), m.group(5)
        if m.group(1):          # usuário/token embutido: NUNCA vai para o argv nem para o .git/config (ver _auth_env)
            auth = {"user": unquote(m.group(1)), "password": unquote(m.group(2) or ""), "port": m.group(4)}
    elif (m := RE_SSH.match(url)):
        kind, host, path = "ssh", m.group(2), m.group(4)
    elif (m := RE_SCP.match(url)):
        kind, host, path = "scp", m.group(2), m.group(3)
    elif url.startswith("http://"):
        raise core.HttpError(400, "http:// sem criptografia não é aceito — use https://")
    elif url.startswith(("file:", "/", "~", "./", "git://")):
        raise core.HttpError(400, "só dá para clonar de https://, ssh:// ou git@host:org/repo")
    else:
        raise core.HttpError(400, "use https://…, ssh://… ou git@host:org/repo(.git)")
    if (BLOCK_HOSTS.match(host) or "." not in host) and not _internal_ok(host):
        raise core.HttpError(400, "host local ou de rede interna não é permitido")
    last = path.rstrip("/").split("/")[-1]
    last = re.sub(r"\.git$", "", last) or host
    display = _CRED_HTTPS.sub(r"\1", url)
    return {"url": display, "kind": kind, "host": host.lower(), "name": last, "display_url": display, "auth": auth}


def _auth_env(info):
    """Credencial de https://usuario:token@host/… → cabeçalho Authorization por VARIÁVEL DE AMBIENTE (GIT_CONFIG_COUNT,
    git ≥ 2.31), restrito a https://host[:porta]/. O clone roda com a URL SEM credencial: o token não aparece no `ps`
    (argv) e o remote.origin.url gravado no .git/config da sala fica limpo."""
    a = info.get("auth")
    if not a:
        return {}
    tok = base64.b64encode(f"{a['user']}:{a['password']}".encode()).decode()
    base = f"https://{info['host']}" + (f":{a['port']}" if a.get("port") else "") + "/"
    return {"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": f"http.{base}.extraHeader",
            "GIT_CONFIG_VALUE_0": f"Authorization: Basic {tok}"}


def _internal_ok(host):
    if os.environ.get("ESC_CLONE_REDE_INTERNA", "") not in ("", "0", "false", "no"):
        return True
    ok = {h.strip().lower() for h in (os.environ.get("ESC_CLONE_HOSTS_INTERNOS") or "").split(",") if h.strip()}
    return host.lower() in ok


def _bad_ip(a):
    ip = ipaddress.ip_address(a.split("%", 1)[0])
    if getattr(ip, "ipv4_mapped", None):
        ip = ip.ipv4_mapped
    return (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast
            or ip.is_unspecified or ip in ipaddress.ip_network("100.64.0.0/10"))


def check_host_resolution(host, timeout=5.0):
    """Anti-SSRF: o host da URL não pode RESOLVER para loopback/rede privada/link-local/ULA (localtest.me, domínio com
    registro A 10.x…). Nome que não resolve passa (o git vai dizer 'could not resolve host'; em ssh pode ser um alias do
    ~/.ssh/config). Rede interna de verdade (GitLab da empresa): ESC_CLONE_HOSTS_INTERNOS=host1,host2 ou
    ESC_CLONE_REDE_INTERNA=1. Resta o DNS rebinding (o git resolve de novo) — documentado em ARCH.md."""
    if _internal_ok(host):
        return
    box = {}

    def _res():
        try:
            box["ips"] = {ai[4][0] for ai in socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)}
        except (OSError, UnicodeError) as e:
            box["err"] = e
    t = threading.Thread(target=_res, daemon=True)
    t.start()
    t.join(timeout)
    for a in sorted(box.get("ips") or ()):
        try:
            bad = _bad_ip(a)
        except ValueError:
            continue
        if bad:
            raise core.HttpError(400, f"o host {host} aponta para um endereço local/interno ({a}) — não é permitido "
                                      "(para um servidor git da sua rede, defina ESC_CLONE_HOSTS_INTERNOS)")


_PROG = re.compile(r"(Counting|Compressing|Receiving|Resolving|Updating files|Checking out|Filtering content)[^:]*:\s+(\d+)%")
PHASE_W = {"Counting": (0, 5), "Compressing": (5, 10), "Receiving": (10, 85), "Resolving": (85, 95),
           "Updating files": (95, 100), "Checking out": (95, 100), "Filtering content": (95, 100)}
PHASE_PT = {"Counting": "contando objetos", "Compressing": "comprimindo", "Receiving": "recebendo objetos",
            "Resolving": "resolvendo deltas", "Updating files": "montando os arquivos", "Checking out": "montando os arquivos",
            "Filtering content": "filtrando conteúdo"}
CLONE_TIMEOUT = core._env_int("ESC_CLONE_TIMEOUT", 600)
CLONE_MAX_BYTES = core._env_int("ESC_CLONE_MAX_MB", 2048) * 1024 * 1024
CLONE_KEEP = 180            # s que um clone terminado continua na lista (o front mostra erro/inauguração)

CLONES = {}                 # id -> Clone
CLONES_LOCK = threading.Lock()
CLONES_N = core.Notifier("esc:clones")


def _pending_names(od):
    with CLONES_LOCK:
        return [c.folder for c in CLONES.values() if c.office_dir == od and c.status == "running"]


class Clone:
    def __init__(self, od, folder, display, info):
        self.id = "c" + time.strftime("%Y%m%d%H%M%S") + secrets.token_hex(2)
        self.office_dir, self.office_id, self.folder, self.display, self.info = od, os.path.basename(od), folder, display, info
        self.tmp = os.path.join(core.meta_dir(od, "tmp"), self.id)
        self.status, self.phase, self.pct, self.error, self.log = "running", "iniciando", 0, None, []
        self.detail = None
        self.started, self.ended, self.proc = _now(), None, None
        self.cancelled = False
        self.kill_reason = None
        self._last_bump = 0.0

    def view(self):
        return {"id": self.id, "office": self.office_id, "room": self.folder, "display": self.display,
                "url": self.info["display_url"], "host": self.info["host"], "status": self.status,
                "phase": self.phase, "pct": self.pct, "detail": self.detail, "error": self.error, "log": self.log[-6:],
                "started": self.started, "ended": self.ended}

    def _bump(self, force=False):
        t = time.monotonic()
        if force or t - self._last_bump > 0.4:
            self._last_bump = t
            CLONES_N.bump()

    def run(self):
        cmd = ["git", *core.GIT_SAFE, "clone", "--progress", "--no-recurse-submodules", "--template=",
               "--", self.info["url"], self.tmp]
        try:
            self.proc = subprocess.Popen(cmd, env={**core.GIT_ENV, **_auth_env(self.info)}, stdin=subprocess.DEVNULL,
                                         stdout=subprocess.DEVNULL,
                                         stderr=subprocess.PIPE, start_new_session=True, cwd=self.office_dir)
        except OSError as e:
            return self._finish("error", f"não consegui rodar o git: {e}")
        if self.cancelled:           # cancelaram entre o start e o Popen
            self._kill(self.kill_reason or "cancel")
        watchdog = threading.Timer(CLONE_TIMEOUT, self._kill, args=("timeout",))
        watchdog.daemon = True
        watchdog.start()
        buf = b""
        last_size = time.monotonic()
        try:
            while True:
                chunk = self.proc.stderr.read1(4096)
                if not chunk:
                    break
                buf += chunk
                *lines, buf = re.split(rb"[\r\n]", buf)
                for raw in lines:
                    self._line(raw.decode("utf-8", "replace").strip())
                self._bump()
                if time.monotonic() - last_size > 2:          # teto de disco (repo gigante enche o disco)
                    last_size = time.monotonic()
                    if _du(self.tmp, CLONE_MAX_BYTES) > CLONE_MAX_BYTES:
                        self._kill("big")
            if buf:
                self._line(buf.decode("utf-8", "replace").strip())
            rc = self.proc.wait()
        finally:
            watchdog.cancel()
        if self.cancelled:
            return self._finish("cancelled" if self.kill_reason == "cancel" else "error", self.error or "cancelado")
        if rc != 0:
            return self._finish("error", _explain(self.log, bool(self.info.get("auth"))))
        try:
            with core.office_lock(self.office_dir):
                final = os.path.join(self.office_dir, self.folder)
                if os.path.lexists(final):
                    self.folder = core.unique_dir_name(self.office_dir, self.folder)
                    final = os.path.join(self.office_dir, self.folder)
                os.rename(self.tmp, final)          # atômico (mesmo filesystem): a sala nasce pronta
            core.register_room(self.office_dir, self.folder, self.display,
                               {"kind": "clone", "url": self.info["display_url"], "host": self.info["host"]})
        except (OSError, core.HttpError) as e:
            return self._finish("error", f"clonou, mas não consegui abrir a sala: {getattr(e, 'msg', e)}")
        self.pct = 100
        self.phase = "pronto"
        return self._finish("done", None)

    def _line(self, line):
        if not line:
            return
        line = _CRED.sub(r"\1", line)[:240]           # nunca mostrar token embutido
        if line.startswith("Cloning into"):            # traz o caminho da pasta temporária: só ruído
            return
        m = _PROG.search(line)
        if m:
            ph, p = m.group(1), int(m.group(2))
            a, b = PHASE_W.get(ph, (0, 100))
            self.phase = PHASE_PT.get(ph, ph)
            d = re.search(r"\((\d+)/(\d+)\)(?:,\s*([\d.]+ \w?i?B)(?:\s*\|\s*([\d.]+ \w?i?B/s))?)?", line)
            if d:   # repo enorme fica minutos em 0%: contagem e velocidade mostram que está andando
                self.detail = {"n": int(d.group(1)), "total": int(d.group(2)), "recv": d.group(3), "speed": d.group(4)}
            self.pct = max(self.pct, min(99, int(a + (b - a) * p / 100)))
            if p == 100 or "done" in line:
                self.log.append(line)
        else:
            self.log.append(line)
        del self.log[:-20]

    def _kill(self, why):
        self.cancelled = True
        self.kill_reason = self.kill_reason or why
        self.error = {"timeout": f"demorou mais de {CLONE_TIMEOUT // 60} min e foi interrompido",
                      "cancel": "cancelado",
                      "big": f"o repositório passou de {CLONE_MAX_BYTES // (1024 * 1024)} MB e o clone foi interrompido",
                      }.get(self.kill_reason, str(self.kill_reason))
        if self.proc and self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)   # git clone tem filhos (remote-https, index-pack)
            except (ProcessLookupError, PermissionError):
                pass
            threading.Timer(5, self._hard_kill).start()

    def _hard_kill(self):
        if self.proc and self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass

    def cancel(self):
        if self.status == "running":
            self._kill("cancel")

    def _finish(self, status, err):
        self.status, self.error, self.ended = status, err, _now()
        if status != "done":
            shutil.rmtree(self.tmp, ignore_errors=True)
        self._bump(force=True)
        return self


def _du(path, cap):
    tot = 0
    for dp, _dn, fn in os.walk(path):
        for f in fn:
            try:
                tot += os.lstat(os.path.join(dp, f)).st_size
            except OSError:
                pass
            if tot > cap:
                return tot
    return tot


def _explain(log, with_auth=False):
    txt = "\n".join(log)
    low = txt.lower()
    if with_auth and ("authentication failed" in low or "terminal prompts disabled" in txt or "403" in txt):
        return "o servidor recusou o usuário/token da URL (confira o token e as permissões dele)"
    if "terminal prompts disabled" in txt or "could not read username" in low or "authentication failed" in low:
        return "repositório privado ou inexistente: sem credencial (para privado, use a URL ssh git@… com chave configurada)"
    if "permission denied (publickey)" in low:
        return "a sua chave SSH não tem acesso a esse repositório"
    if "host key verification failed" in low:
        return "host SSH desconhecido: conecte uma vez pelo terminal (ssh -T git@host) para aceitar a chave"
    if "could not resolve host" in low or "network is unreachable" in low or "timed out" in low:
        return "sem rede ou host inexistente"
    if "not found" in low or "does not exist" in low or "does not appear to be a git repository" in low:
        return "repositório não encontrado"
    if "not allowed" in low:
        return "transporte recusado pela política de segurança"
    if "no space left" in low:
        return "sem espaço em disco"
    last = [ln for ln in log if ln.startswith(("fatal:", "error:"))] or log
    return (last[-1] if last else "o git clone falhou")[:300]


def _clones_of(od, keep=CLONE_KEEP):
    now = _now()
    with CLONES_LOCK:
        for cid in [k for k, c in CLONES.items() if c.ended and now - c.ended > 3600]:
            del CLONES[cid]                 # esquece clones velhos (memória)
        return [c.view() for c in sorted(CLONES.values(), key=lambda c: c.started)
                if c.office_dir == od and (c.status == "running" or (c.ended and now - c.ended < keep))]


def start_clone(ctx, q):
    """POST /api/rooms/clone {office, url, name?} → 202 CLONE."""
    body = ctx.json()
    info = validate_clone_url(body.get("url"))           # 400 antes de qualquer processo
    od = ctx.office_dir()
    name = body.get("name")
    if name is not None and not isinstance(name, str):
        raise core.HttpError(400, "nome inválido")
    name = (name or "").strip()
    if len(name) > 200:
        raise core.HttpError(400, "nome longo demais")
    base = core.sanitize_name(name or info["name"])
    display = _shown(name or info["name"], base)
    check_host_resolution(info["host"])                  # 400 se o nome resolve para rede interna
    with core.office_lock(od):
        folder = core.unique_dir_name(od, base, _pending_names(od))
        with CLONES_LOCK:                                # contagem E inserção no MESMO bloco (sem corrida)
            running = sum(1 for c in CLONES.values() if c.status == "running")
            if running >= core.CLONE_MAX:
                raise core.HttpError(429, f"já há {running} clones em andamento — espere um terminar")
            c = Clone(od, folder, display, info)
            CLONES[c.id] = c
    threading.Thread(target=c.run, name=f"clone-{c.id}", daemon=True).start()
    CLONES_N.bump()
    return c.view(), 202


def list_clones(ctx, q):
    """GET /api/rooms/clones?office=[&wait=&etag=] → {clones, etag} (long-poll pelo etag = versão do Notifier)."""
    od = ctx.office_dir()
    wait = core.clamp_wait(q.get("wait"), 25)
    etag = q.get("etag")
    if wait > 0 and etag is not None and str(etag) == str(CLONES_N.version):
        with core.longpoll_slot("clones", 4) as ok:
            if ok:
                CLONES_N.wait(etag, wait, gone=ctx.client_gone)
    return {"clones": _clones_of(od), "etag": str(CLONES_N.version)}


def _clone_by_id(ctx):
    cid = ctx.params.get("id", "")
    if not CLONE_ID_RE.match(cid):
        raise core.HttpError(400, "id de clone inválido")
    with CLONES_LOCK:
        c = CLONES.get(cid)
    if not c:
        raise core.HttpError(404, "clone não encontrado")
    oid = ctx.query.get("office") or (ctx.json().get("office") if ctx.method == "POST" else None)
    if oid and core.office_dir(oid) != c.office_dir:
        raise core.HttpError(404, "clone não encontrado")
    return c


def get_clone(ctx, q):
    return _clone_by_id(ctx).view()


def cancel_clone(ctx, q):
    c = _clone_by_id(ctx)
    c.cancel()
    return {"ok": True, "status": c.status}


def _cleanup_tmp(od):
    """Restos de clones de um servidor anterior (morreu no meio): apaga pastas c* em .escritorio/tmp sem dono."""
    tmp = os.path.join(od, core.META_DIR, "tmp")
    if not os.path.isdir(tmp):
        return
    with CLONES_LOCK:
        mine = {c.id for c in CLONES.values() if c.office_dir == od}
    for n in os.listdir(tmp):
        p = os.path.join(tmp, n)
        if CLONE_ID_RE.match(n) and n not in mine and not os.path.islink(p):
            try:
                if _now() - os.lstat(p).st_mtime > 60:
                    shutil.rmtree(p, ignore_errors=True)
            except OSError:
                pass


_cleaned = set()


def enrich_office(office_id, od, data):
    """OFFICE_ENRICHER: GET /api/office/{office} ganha "clones" (em curso + terminados há pouco)."""
    if od not in _cleaned:
        _cleaned.add(od)
        _cleanup_tmp(od)
    data["clones"] = _clones_of(od)


# ============================================================ metadados (PATCH)
def patch_room(ctx, q):
    """PATCH /api/rooms/{room}?office= {display?, color?, order?:[ids]} → ROOM. Só enfeite: a pasta nunca muda."""
    oid = ctx.office_id()
    folder = ctx.params["room"]
    core.room_dir(oid, folder)
    od = core.office_dir(oid)
    body = ctx.json()
    core.list_rooms(oid)          # sincroniza o json com o disco antes de mexer
    with core.office_lock(od):
        m = core.read_meta(od)
        entry = m["rooms"].get(folder)
        if entry is None:
            raise core.HttpError(404, "sala não existe")
        if "display" in body:
            if not isinstance(body["display"], str) or not _shown(body["display"]):
                raise core.HttpError(400, "nome exibido inválido")
            entry["display"] = _shown(body["display"])
        if "color" in body:
            if not isinstance(body["color"], str) or not COLOR_RE.match(body["color"]):
                raise core.HttpError(400, "cor inválida (use #rrggbb)")
            entry["color"] = body["color"].lower()
        if "order" in body:
            order = body["order"]
            if not isinstance(order, list) or not all(isinstance(x, str) for x in order) or len(set(order)) != len(order) \
                    or set(order) != set(m["order"]):
                raise core.HttpError(400, "order precisa ter exatamente as salas existentes, sem repetir")
            m["order"] = order
        core.write_meta(od, m)
    core.bump(f"esc:rooms:{oid}")
    return _room_view(oid, folder)


# ============================================================ arquivos da sala
def _room(ctx):
    return core.room_dir(ctx.office_id(), ctx.params["room"])


def rel_in_room(room, rel):
    """Caminho relativo dentro da sala → real. '..' → 400; .git → 403; symlink para fora → 403."""
    if rel is not None and not isinstance(rel, str):
        raise core.HttpError(400, "caminho inválido")
    rel = (rel or "").replace("\\", "/").strip("/")
    parts = [x for x in rel.split("/") if x]
    if any(x in (".", "..") or "\x00" in x for x in parts):
        raise core.HttpError(400, "caminho inválido")
    if any(x.lower() == ".git" for x in parts):
        raise core.HttpError(403, ".git não é navegável")
    if not parts:
        return room
    p = core.within(room, os.path.join(room, *parts))
    rp = os.path.relpath(p, room)
    if any(x.lower() == ".git" for x in rp.split(os.sep)):      # symlink interno apontando para .git
        raise core.HttpError(403, ".git não é navegável")
    return p


def _rel(room, p):
    return "" if p == room else os.path.relpath(p, room).replace(os.sep, "/")


def list_files(ctx, q):
    """GET /api/rooms/{room}/files?office=&path=&offset=0&limit=300&all=0."""
    room = _room(ctx)
    p = rel_in_room(room, q.get("path"))
    if not os.path.isdir(p):
        raise core.HttpError(404, "não é uma pasta")
    try:
        offset = max(0, int(q.get("offset") or 0))
        limit = max(1, min(LIST_MAX, int(q.get("limit") or LIST_MAX)))
    except ValueError:
        raise core.HttpError(400, "offset/limit inválidos") from None
    show_all = q.get("all") in ("1", "true")
    ents, ignored, capped = [], [], False
    with os.scandir(p) as it:
        for i, e in enumerate(it):
            if i >= SCAN_MAX:
                capped = True
                break
            try:
                link = e.is_symlink()
                isdir = e.is_dir(follow_symlinks=False)
            except OSError:
                continue
            if e.name == ".git" or (isdir and e.name in IGNORED_DIRS):
                ignored.append(e.name)
                if not show_all or e.name == ".git":
                    continue
            ents.append((e, isdir, link))
    ents.sort(key=lambda t: (not t[1], t[0].name.lower()))
    total = len(ents)
    out = []
    for e, isdir, link in ents[offset:offset + limit]:
        try:
            st = e.stat(follow_symlinks=False)
        except OSError:
            continue
        item = {"name": e.name, "type": "dir" if isdir else ("link" if link else "file"),
                "size": 0 if isdir else st.st_size, "mtime": int(st.st_mtime)}
        if link:      # symlink aparece, mas só é navegável se o alvo real ficar dentro da sala
            try:
                target = rel_in_room(room, _rel(room, p) + "/" + e.name)
                item["link_inside"] = True
                item["link_dir"] = os.path.isdir(target)
            except core.HttpError:
                item["link_inside"] = False
        out.append(item)
    return {"room": ctx.params["room"], "rel": _rel(room, p), "total": total, "offset": offset,
            "truncated": capped or offset + limit < total, "capped": capped, "ignored": sorted(set(ignored)),
            "entries": out}


def room_summary(room, budget_s=0.4, cap=20000):
    """Números para a arte diegética: arquivos/pastas e extensões (orçamento de tempo + teto; nunca varre ignorados)."""
    t0 = time.monotonic()
    files = dirs = 0
    by_ext = {}
    capped = False
    for dp, dn, fn in os.walk(room):
        dn[:] = [d for d in dn if d not in IGNORED_DIRS and not os.path.islink(os.path.join(dp, d))]
        dirs += len(dn)
        for f in fn:
            files += 1
            ext = os.path.splitext(f)[1].lower() or "(sem)"
            if len(ext) > 12:
                ext = "(sem)"
            by_ext[ext] = by_ext.get(ext, 0) + 1
        if files >= cap or time.monotonic() - t0 > budget_s:
            capped = True
            break
    top = sorted(by_ext.items(), key=lambda kv: -kv[1])[:8]
    return {"files": files, "dirs": dirs, "capped": capped, "top_ext": top, "ms": int((time.monotonic() - t0) * 1000)}


def room_top(room, max_dirs=16, max_files=12):
    """1º nível: pastas (gavetas do arquivo de aço) e arquivos soltos (pilhas de papel)."""
    dirs, files = [], []
    n = 0
    with os.scandir(room) as it:
        for e in it:
            n += 1
            if n > SCAN_MAX:
                break
            if e.name == ".git":
                continue
            try:
                if e.is_dir(follow_symlinks=False):
                    if e.name not in IGNORED_DIRS:
                        dirs.append(e.name)
                elif e.is_file(follow_symlinks=False):
                    files.append(e.name)
            except OSError:
                continue
    dirs.sort(key=lambda s: (s.startswith("."), s.lower()))
    files.sort(key=lambda s: (s.startswith("."), s.lower()))
    return {"dirs": dirs[:max_dirs], "dirs_total": len(dirs), "files": files[:max_files], "files_total": len(files)}


_summary_cache = {}      # room real → (t, summary)


def cached_summary(room, fresh=False, budget=0.4):
    hit = _summary_cache.get(room)
    if hit and not fresh and time.monotonic() - hit[0] < SUMMARY_TTL:
        return hit[1]
    s = room_summary(room, budget_s=budget)
    _summary_cache[room] = (time.monotonic(), s)
    if len(_summary_cache) > 256:
        _summary_cache.pop(next(iter(_summary_cache)))
    return s


def summary(ctx, q):
    return cached_summary(_room(ctx), fresh=q.get("fresh") == "1")


def read_file(ctx, q):
    """GET /api/rooms/{room}/file?office=&path= → {rel, size, mtime, kind, content?, truncated?}."""
    room = _room(ctx)
    p = rel_in_room(room, q.get("path"))
    if not os.path.isfile(p):
        raise core.HttpError(404, "não é um arquivo")
    st = os.stat(p)
    base = {"rel": _rel(room, p), "size": st.st_size, "mtime": int(st.st_mtime)}
    ext = os.path.splitext(p)[1].lower()
    if ext in core.IMAGE_EXT and st.st_size <= core.MAX_RAW:
        return {**base, "kind": "image"}
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_NONBLOCK", 0))
    with os.fdopen(fd, "rb") as f:
        head = f.read(READ_MAX)
    if core.is_binary(head):
        return {**base, "kind": "binary"}
    return {**base, "kind": "text", "content": head.decode("utf-8", "replace"), "truncated": st.st_size > READ_MAX}


def raw_file(ctx, q):
    """GET /api/rooms/{room}/raw?office=&path= → bytes de imagem com CSP sandbox (o front usa api.blobUrl)."""
    room = _room(ctx)
    p = rel_in_room(room, q.get("path"))
    ext = os.path.splitext(p)[1].lower()
    if ext not in core.IMAGE_EXT:
        raise core.HttpError(415, "só imagens")
    if not os.path.isfile(p):
        raise core.HttpError(404, "não é um arquivo")
    if os.path.getsize(p) > core.MAX_RAW:
        raise core.HttpError(413, "imagem grande demais")
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as f:
        data = f.read(core.MAX_RAW + 1)
    mime = mimetypes.guess_type(p)[0] or "application/octet-stream"
    return core.Response(data, mime, 200, {"Content-Security-Policy": RAW_CSP, "Content-Disposition": "inline"})


# ============================================================ git (barato e seguro)
# A configuração é lida PELO PRÓPRIO GIT (git config --list), nunca por um parser nosso: ele já considera BOM, include,
# extensions.worktreeConfig/config.worktree e commondir exatamente como o `git status` vai considerar. `git config`
# não executa filtro, hook nem fsmonitor. Depois: filtros definidos no repositório são neutralizados e chaves que
# fazem o git executar/ler algo de fora tornam a sala "suspeita" (só o .git/HEAD é lido).
DANGER_KEYS = {"core.fsmonitor", "core.hookspath", "core.sshcommand", "core.pager", "core.worktree", "core.gitproxy",
               "core.askpass"}
_FILTER_KEY = re.compile(r"^filter\.(.+)\.([a-z]+)$")
REPO_SCOPES = ("local", "worktree")      # vem do repositório (o global/system é do usuário: confiável, ex. git-lfs)


def _git_base(room):
    """git com o repositório EXPLÍCITO (sem descoberta subindo pastas; core.worktree ignorado)."""
    return ["git", f"--git-dir={os.path.join(room, '.git')}", f"--work-tree={room}", *core.GIT_SAFE]


def git_config_risk(room):
    """Configuração efetiva do repositório da sala → (suspeito: str|None, filtros: [nomes a neutralizar])."""
    gd = os.path.join(room, ".git")
    if os.path.islink(gd) or not os.path.isdir(gd):
        return ".git não é uma pasta comum (worktree/submódulo/symlink)", []
    if os.path.lexists(os.path.join(gd, "commondir")):
        return "o .git aponta para outro repositório (commondir)", []
    cfg = os.path.join(gd, "config")
    try:
        if os.path.islink(cfg):
            return ".git/config é symlink", []
        if os.path.getsize(cfg) > 256 * 1024:
            return ".git/config grande demais", []
    except FileNotFoundError:
        return ".git sem config", []
    except OSError as e:
        return f"não consegui ler .git/config: {e}", []
    try:
        r = subprocess.run([*_git_base(room), "config", "--list", "--show-scope", "-z"], env=core.GIT_ENV,
                           capture_output=True, timeout=3, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return "git config demorou demais", []
    except OSError as e:
        return f"git indisponível: {e}", []
    if r.returncode:
        return "configuração do git ilegível: " + r.stderr.decode("utf-8", "replace").strip()[-160:], []
    toks = r.stdout.split(b"\0")
    filters = set()
    for i in range(0, len(toks) - 1, 2):             # -z --show-scope: "escopo\0chave\nvalor\0"
        scope = toks[i].decode("utf-8", "replace")
        key = toks[i + 1].split(b"\n", 1)[0].decode("utf-8", "replace")
        if scope not in REPO_SCOPES:
            continue
        low = key.lower()
        if low.startswith(("include.", "includeif.")):
            return "a configuração do repositório usa include", []
        if low in DANGER_KEYS:
            return f"a configuração do repositório define {key}", []
        m = _FILTER_KEY.match(key)
        if m:
            name = m.group(1)
            if re.search(r'[=\s"\\\x00-\x1f]', name):
                return "filtro com nome estranho na configuração do repositório", []
            filters.add(name)
    return None, sorted(filters)


_git_cache = {}          # room real → (t, status)


def git_status(room, fresh=False):
    """Resumo barato (1 processo, timeout 3 s), com cache de 5 s. Nunca roda git num .git/config suspeito."""
    hit = _git_cache.get(room)
    if hit and not fresh and time.monotonic() - hit[0] < GIT_TTL:
        return hit[1]
    st = _git_status(room)
    _git_cache[room] = (time.monotonic(), st)
    if len(_git_cache) > 256:
        _git_cache.pop(next(iter(_git_cache)))
    return st


def _head_only(room):
    """Sem rodar git: branch pelo .git/HEAD (arquivo de texto)."""
    try:
        with open(os.path.join(room, ".git", "HEAD"), "rb") as f:
            head = f.read(300).decode("utf-8", "replace").strip()
    except OSError:
        return None
    m = re.match(r"ref:\s*refs/heads/(.+)$", head)
    return m.group(1)[:100] if m else "(desanexado)"


def _git_status(room):
    t0 = time.monotonic()
    if not os.path.lexists(os.path.join(room, ".git")):
        return {"repo": False, "ms": 0}
    why, filters = git_config_risk(room)
    if why:
        return {"repo": True, "branch": _head_only(room), "head": None, "ahead": None, "behind": None, "dirty": None,
                "untracked": None, "suspicious": True, "error": why, "ms": int((time.monotonic() - t0) * 1000)}
    neutral = []
    for f in filters:
        neutral += ["-c", f"filter.{f}.clean=", "-c", f"filter.{f}.smudge=", "-c", f"filter.{f}.process=",
                    "-c", f"filter.{f}.required=false"]
    try:
        r = subprocess.run([*_git_base(room), *neutral, "status", "--porcelain=v2", "--branch",
                            "--untracked-files=normal", "--ignore-submodules=all"],
                           env=core.GIT_ENV, capture_output=True, timeout=3, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return {"repo": True, "branch": _head_only(room), "error": "git status demorou demais", "partial": True,
                "ms": int((time.monotonic() - t0) * 1000)}
    except OSError as e:
        return {"repo": True, "branch": _head_only(room), "error": f"git indisponível: {e}", "ms": 0}
    if r.returncode:
        return {"repo": True, "branch": _head_only(room), "error": r.stderr.decode("utf-8", "replace").strip()[-200:],
                "ms": int((time.monotonic() - t0) * 1000)}
    st = {"repo": True, "branch": None, "head": None, "ahead": None, "behind": None, "dirty": 0, "untracked": 0}
    for line in r.stdout.decode("utf-8", "replace").splitlines():
        if line.startswith("# branch.head "):
            st["branch"] = line.split(" ", 2)[2][:100]
        elif line.startswith("# branch.oid "):
            v = line.split(" ", 2)[2]
            st["head"] = None if v == "(initial)" else v[:7]
        elif line.startswith("# branch.ab "):
            m = re.match(r"# branch\.ab \+(\d+) -(\d+)", line)
            if m:
                st["ahead"], st["behind"] = int(m.group(1)), int(m.group(2))
        elif line.startswith("? "):
            st["untracked"] += 1
        elif line and not line.startswith("#"):
            st["dirty"] += 1
    if st["branch"] == "(detached)":
        st["branch"] = "(desanexado)"
    if filters:
        st["filters_neutralized"] = filters
    st["ms"] = int((time.monotonic() - t0) * 1000)
    return st


def git_route(ctx, q):
    return git_status(_room(ctx), fresh=q.get("fresh") == "1")


# ============================================================ visão geral (placas + gaveteiros do prédio num pedido só)
def overview(ctx, q):
    """GET /api/rooms/overview?office=[&room=&fresh=1] → {rooms:{id:{summary, top, git}}, ms}."""
    oid = ctx.office_id()
    t0 = time.monotonic()
    only = q.get("room")
    fresh = q.get("fresh") == "1"
    ids = [only] if only else [r["id"] for r in core.list_rooms(oid)]
    out = {}
    for rid in ids[:60]:
        try:
            rd = core.room_dir(oid, rid)
        except core.HttpError:
            if only:
                raise
            continue
        late = time.monotonic() - t0 > 3.0         # muitos projetos grandes: o resto vem com orçamento mínimo
        try:
            out[rid] = {"summary": cached_summary(rd, fresh=fresh, budget=0.05 if late else 0.25),
                        "top": room_top(rd), "git": git_status(rd, fresh=fresh)}
        except OSError as e:
            out[rid] = {"error": str(e)}
    return {"rooms": out, "ms": int((time.monotonic() - t0) * 1000)}


# ============================================================ canal sondado por sala (refresh leve)
def _fs_probe_value(oid, rid):
    try:
        rd = core.room_dir(oid, rid)
    except core.HttpError:
        return "sumiu"
    vals = [os.stat(rd).st_mtime_ns]
    with os.scandir(rd) as it:
        for i, e in enumerate(it):
            if i > 400:
                break
            try:
                vals.append((e.name, e.stat(follow_symlinks=False).st_mtime_ns))
            except OSError:
                pass
    for f in (".git/index", ".git/HEAD"):
        try:
            vals.append((f, os.stat(os.path.join(rd, f)).st_mtime_ns))
        except OSError:
            pass
    return hash(tuple(sorted(vals, key=repr)))


def _sala_factory(name):
    rest = name[len("esc:sala:"):]
    oid, sep, rid = rest.partition("/")
    if not sep:
        return None
    try:
        core.room_dir(oid, rid)
    except core.HttpError:
        return None
    return lambda: _fs_probe_value(oid, rid)


core.channel_prefix("esc:sala:", _sala_factory, interval=2.0)


# ORDEM importa: os padrões de sala ({room}/files...) vêm ANTES de clones/{id}, senão uma sala chamada "clones"
# teria /api/rooms/clones/files capturado pela rota do clone. Um id de clone nunca é files/summary/file/raw/git.
ROUTES = {
    ("POST", "/api/rooms"): create_room,
    ("POST", "/api/rooms/clone"): start_clone,
    ("GET", "/api/rooms/clones"): list_clones,
    ("GET", "/api/rooms/overview"): overview,
    ("PATCH", "/api/rooms/{room}"): patch_room,
    ("GET", "/api/rooms/{room}/files"): list_files,
    ("GET", "/api/rooms/{room}/summary"): summary,
    ("GET", "/api/rooms/{room}/file"): read_file,
    ("GET", "/api/rooms/{room}/raw"): raw_file,
    ("GET", "/api/rooms/{room}/git"): git_route,
    ("GET", "/api/rooms/clones/{id}"): get_clone,
    ("POST", "/api/rooms/clones/{id}/cancel"): cancel_clone,
}
OFFICE_ENRICHERS = [enrich_office]
