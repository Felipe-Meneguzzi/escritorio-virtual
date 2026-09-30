"""Escritório — núcleo compartilhado do backend (server.py e features/*.py importam daqui).

Copiado e adaptado do arq_core.py do Arquipélago (nada é importado de lá).

IMPORTANTE para features: ROOT, ROOT_REAL e PORT mudam em runtime (server.py aplica --root/--port).
Leia sempre como atributo do módulo — `import esc_core as core; core.ROOT` — nunca
`from esc_core import ROOT` (isso congela o valor padrão).

Modelo de pastas (ver ARCH.md §Backend):
    <ROOT>/                        raiz de escritórios (padrão ~/escritorios; --root ou ESC_ROOT)
      <Escritório>/                um escritório = uma empresa
        quadro/*.md                quadro de anotações
        .escritorio/               metadados (office.json, tmp/, lixeira/, rh/, arquivo/)
        <Sala>/                    cada subpasta real (não oculta, não reservada, não symlink) = sala = projeto
"""
import json
import os
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import threading
import time
import unicodedata
from contextlib import contextmanager
from pathlib import Path

HERE = Path(__file__).resolve().parent
JS_DIR = HERE / "js"
MAX_BODY = 1024 * 1024        # corpo máximo aceito em POST/PUT de feature
MAX_RAW = 30 * 1024 * 1024    # maior arquivo servido cru (estáticos, imagens)
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".avif"}

ROOT = Path(os.environ.get("ESC_ROOT") or (Path.home() / "escritorios"))
PORT = 8766
ROOT_REAL = None              # realpath(ROOT) calculado no boot; None = calcula na hora

META_DIR = ".escritorio"      # metadados do escritório (NUNCA dentro das salas)
QUADRO = "quadro"             # notas .md
RESERVED = {META_DIR, QUADRO}
WIN_RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}
NAME_MAX_CHARS = 60
NAME_MAX_BYTES = 120
ROOM_COLORS = ["#c9b28a", "#8fa6b8", "#b88f8f", "#9bb58f", "#b8a36b", "#a58fb8", "#8fb8b1", "#c29a6b"]

# Limites globais (features leem daqui; env sobrescreve)
def _env_int(name, default):
    try:
        return int(os.environ.get(name) or default)
    except ValueError:
        return default


MAX_FUNC = _env_int("ESC_MAX_FUNC", 4)          # funcionários (processos claude) simultâneos
CLONE_MAX = 2                                   # clones simultâneos
NOTE_MAX = 256 * 1024                           # bytes por nota do quadro
NOTES_MAX = 300                                 # notas por quadro

# OFFICE_ENRICHERS: fn(office_id: str, office_dir: str, data: dict) -> None — features acrescentam campos no
# GET /api/office/{office} (ex.: salas põe "clones", rh põe "staff"). server.py preenche no boot.
OFFICE_ENRICHERS = []


def dry_run() -> bool:
    """ESC_DRY_RUN=1: nada de GUI/processo externo do Windows é executado, só logado."""
    return os.environ.get("ESC_DRY_RUN", "") not in ("", "0", "false", "no")


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


class HttpError(Exception):
    """Levante em handlers para responder {"error": msg, **extra} com o status dado.
        raise core.HttpError(409, "nota mudou", current=note)"""

    def __init__(self, status: int, msg: str, **extra):
        super().__init__(msg)
        self.status = status
        self.msg = msg
        self.extra = extra


class Response:
    """Resposta não-JSON de handler de feature (bytes crus)."""

    def __init__(self, body: bytes, content_type: str = "application/octet-stream", status: int = 200, headers=None):
        self.body = body
        self.content_type = content_type
        self.status = status
        self.headers = headers or {}


def json_bytes(data) -> bytes:
    return json.dumps(data, ensure_ascii=False).encode()


# ============================================================ caminhos: tudo passa por realpath dentro da raiz
def _inside(path: str, root: str) -> bool:
    return path == root or os.path.commonpath([path, root]) == root


def root_real() -> str:
    return ROOT_REAL or os.path.realpath(ROOT)


def within(base: str, path: str) -> str:
    """realpath(path) tem que ficar dentro de realpath(base). Devolve o caminho REAL. 403 se escapar
    (inclusive por symlink)."""
    b = os.path.realpath(base)
    p = os.path.realpath(path)
    if not _inside(p, b):
        raise HttpError(403, "fora do escritório")
    return p


def within_root(path: str) -> str:
    """Caminho (absoluto ou relativo à raiz) → real, garantido dentro da raiz de escritórios."""
    return within(root_real(), path if os.path.isabs(path) else os.path.join(root_real(), path))


def child(base: str, name: str) -> str:
    """Um componente só (sem '/', sem '..', sem NUL), dentro de base. Devolve o caminho real."""
    if not isinstance(name, str) or not name or "/" in name or "\\" in name or "\x00" in name or name in (".", ".."):
        raise HttpError(400, "nome inválido")
    return within(base, os.path.join(base, name))


def office_dir(office_id) -> str:
    """id (nome da pasta) do escritório → caminho real validado. 400 nome inválido, 404 inexistente."""
    if not isinstance(office_id, str) or not office_id or office_id.startswith("."):
        raise HttpError(400, "escritório inválido")
    p = child(root_real(), office_id)
    if not os.path.isdir(p) or os.path.islink(os.path.join(root_real(), office_id)):
        raise HttpError(404, "escritório não existe")
    return p


def is_room_name(name: str) -> bool:
    return bool(name) and not name.startswith(".") and name not in RESERVED


def room_dir(office_id, room_id) -> str:
    """Sala (pasta de projeto) → caminho real validado dentro do escritório. 400/404 como office_dir.
    Nunca aceita 'quadro', '.escritorio', ocultas ou symlink."""
    od = office_dir(office_id)
    if not isinstance(room_id, str) or not is_room_name(room_id):
        raise HttpError(404 if room_id in RESERVED else 400, "sala inválida")
    lex = os.path.join(od, room_id)
    p = child(od, room_id)
    if os.path.islink(lex) or not os.path.isdir(p):
        raise HttpError(404, "sala não existe")
    return p


def meta_dir(office_id_or_dir, *parts, create=True) -> str:
    """<escritório>/.escritorio[/parts...] (cria se preciso). Aceita o id ou o caminho já validado."""
    od = office_id_or_dir if os.path.isabs(office_id_or_dir) else office_dir(office_id_or_dir)
    d = os.path.join(od, META_DIR, *parts)
    if create:
        os.makedirs(d, exist_ok=True)
    return within(od, d)


# ============================================================ nomes → pastas
_BAD = re.compile(r"[^\w .,()&+'@!-]", re.UNICODE)   # \w (unicode) cobre letras acentuadas, dígitos e _


def sanitize_name(display: str) -> str:
    """Nome exibido → nome de pasta. Mantém acentos e espaços. 400 se não sobrar nada utilizável ou se for
    reservado. Ex.: "  ../../etc " → "etc"; "a/b\\c" → "a-b-c"; "💼 Paper Co" → "Paper Co"."""
    if not isinstance(display, str):
        raise HttpError(400, "nome inválido")
    s = unicodedata.normalize("NFC", display)
    s = "".join(ch for ch in s if unicodedata.category(ch)[0] != "C")   # controle, formato (RTL override)...
    s = s.replace("/", "-").replace("\\", "-")
    s = _BAD.sub("-", s)
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"-{2,}", "-", s)
    s = re.sub(r"(^|\s)-+(?=\s|$)", r"\1", s)        # hífen solto (do emoji removido) some
    s = re.sub(r"\s+", " ", s)
    s = s.strip(" .-_")               # sem começar com . (oculta) ou - (flag), sem terminar em . ou espaço
    if len(s) > NAME_MAX_CHARS:
        s = s[:NAME_MAX_CHARS].rstrip(" .-_")
    while len(s.encode()) > NAME_MAX_BYTES:
        s = s[:-1].rstrip(" .-_")
    if not s or s in (".", ".."):
        raise HttpError(400, "o nome precisa ter letras ou números")
    if s.lower() in RESERVED or s.split(".")[0].lower() in WIN_RESERVED:
        raise HttpError(400, f"“{s}” é um nome reservado")
    return s


def claude_key(path: str) -> str:
    """Como o Claude Code nomeia ~/.claude/projects/<chave> para um cwd: tudo fora de [A-Za-z0-9-] vira '-'."""
    return re.sub(r"[^A-Za-z0-9-]", "-", path)


def unique_dir_name(parent: str, base: str, taken_extra=()) -> str:
    """base, "base (2)", "base (3)"… — colisão sem diferenciar maiúsculas E pela chave de projeto do Claude
    (duas salas com a mesma chave misturariam transcripts). taken_extra = nomes reservados (clones em curso)."""
    try:
        existing = os.listdir(parent)
    except FileNotFoundError:
        existing = []
    names = list(existing) + list(taken_extra)
    low = {n.lower() for n in names}
    keys = {claude_key(os.path.join(parent, n)) for n in names}
    for i in range(1, 100):
        cand = base if i == 1 else f"{base} ({i})"
        if cand.lower() not in low and claude_key(os.path.join(parent, cand)) not in keys:
            return cand
    raise HttpError(409, "nomes parecidos demais")


# ============================================================ metadados (office.json), escrita atômica
_locks = {}
_locks_guard = threading.Lock()


def office_lock(od: str) -> threading.RLock:
    """RLock por escritório (caminho real). Use em qualquer leitura-modificação-escrita do office.json."""
    with _locks_guard:
        return _locks.setdefault(od, threading.RLock())


def atomic_write(path: str, data: bytes, mode=0o644) -> None:
    """tmp + fsync + os.replace (nunca deixa arquivo pela metade)."""
    d = os.path.dirname(path)
    tmp = os.path.join(d, f".{os.path.basename(path)}.{secrets.token_hex(4)}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def meta_path(od: str) -> str:
    return os.path.join(od, META_DIR, "office.json")


def read_meta(od: str) -> dict:
    try:
        with open(meta_path(od), encoding="utf-8") as f:
            m = json.load(f)
        if isinstance(m, dict) and m.get("version") == 1:
            m.setdefault("rooms", {})
            m.setdefault("order", [])
            return m
    except (OSError, ValueError):
        pass
    return {"version": 1, "name": os.path.basename(od), "created": int(time.time()), "rooms": {}, "order": []}


def write_meta(od: str, m: dict) -> None:
    os.makedirs(os.path.join(od, META_DIR), exist_ok=True)
    atomic_write(meta_path(od), json.dumps(m, ensure_ascii=False, indent=1).encode())


# ============================================================ escritórios
def list_offices() -> list:
    root = root_real()
    try:
        names = sorted(os.listdir(root), key=str.lower)
    except FileNotFoundError:
        return []
    out = []
    for n in names:
        p = os.path.join(root, n)
        if n.startswith(".") or os.path.islink(p) or not os.path.isdir(p):
            continue
        has_meta = os.path.isfile(meta_path(p))
        m = read_meta(p)
        out.append({"id": n, "name": m.get("name") or n, "created": m.get("created"), "has_meta": has_meta})
    return out


def create_office(display: str) -> dict:
    """Cria <ROOT>/<pasta>/ com quadro/ e .escritorio/office.json. 409 se já existe (sem diferenciar maiúsculas)."""
    folder = sanitize_name(display)
    root = root_real()
    os.makedirs(root, mode=0o755, exist_ok=True)
    same = [n for n in os.listdir(root) if n.lower() == folder.lower()]
    if same:
        raise HttpError(409, f"já existe um escritório “{same[0]}”", id=same[0])
    p = os.path.join(root, folder)
    try:
        os.mkdir(p)                   # mkdir é atômico: corrida entre dois pedidos → FileExistsError
    except FileExistsError:
        raise HttpError(409, f"já existe um escritório “{folder}”", id=folder) from None
    os.mkdir(os.path.join(p, QUADRO))
    m = read_meta(p)
    shown = "".join(ch for ch in unicodedata.normalize("NFC", display) if unicodedata.category(ch)[0] != "C")
    m["name"] = " ".join(shown.split())[:NAME_MAX_CHARS] or folder
    m["created"] = int(time.time())
    write_meta(p, m)
    welcome = (f"# Bem-vindo ao {m['name']}\n\n"
               "Este é o quadro de anotações. Cada nota é um arquivo `.md` na pasta `quadro/`.\n\n"
               "- [ ] Criar a primeira sala (projeto)\n- [ ] Contratar um funcionário\n")
    atomic_write(os.path.join(p, QUADRO, "Bem-vindo.md"), welcome.encode())
    return {"id": folder, "name": m["name"], "path": p}


# ============================================================ salas (listagem; criação/clone ficam em features/salas.py)
def _room_dirs(od: str) -> list:
    dirs = []
    with os.scandir(od) as it:
        for e in it:
            if not is_room_name(e.name) or e.is_symlink() or not e.is_dir(follow_symlinks=False):
                continue
            dirs.append(e.name)
    return dirs


def list_rooms(office_id) -> list:
    """Salas = subpastas reais. office.json guarda só enfeite (display, cor, origem) e ordem: pasta criada por
    fora aparece (source.kind 'externa'); pasta apagada por fora some. Ordem = order do json (novas no fim)."""
    od = office_dir(office_id)
    with office_lock(od):
        m = read_meta(od)
        dirs = _room_dirs(od)
        changed = False
        for gone in [k for k in m["rooms"] if k not in dirs]:
            del m["rooms"][gone]
            changed = True
        order = [n for n in m.get("order", []) if n in dirs]
        for n in sorted(dirs, key=str.lower):
            if n not in order:
                order.append(n)
            if n not in m["rooms"]:
                m["rooms"][n] = {"display": n, "color": ROOM_COLORS[(len(order) - 1) % len(ROOM_COLORS)],
                                 "created": int(os.stat(os.path.join(od, n)).st_mtime), "source": {"kind": "externa"}}
                changed = True
        if order != m.get("order"):
            m["order"] = order
            changed = True
        if changed and os.path.isdir(os.path.join(od, META_DIR)):
            write_meta(od, m)
    return [{"id": n, "path": os.path.join(od, n), **m["rooms"][n],
             "git": os.path.isdir(os.path.join(od, n, ".git"))} for n in order]


def register_room(office_id_or_dir, folder: str, display: str, source: dict) -> dict:
    """Grava/atualiza a entrada da sala no office.json (use depois de criar a pasta). Devolve a entrada."""
    od = office_id_or_dir if os.path.isabs(office_id_or_dir) else office_dir(office_id_or_dir)
    with office_lock(od):
        m = read_meta(od)
        entry = m["rooms"].get(folder) or {}
        entry.update({"display": (display or folder)[:NAME_MAX_CHARS],
                      "color": entry.get("color") or ROOM_COLORS[len(m["order"]) % len(ROOM_COLORS)],
                      "created": entry.get("created") or int(time.time()), "source": source or {"kind": "zero"}})
        m["rooms"][folder] = entry
        if folder not in m["order"]:
            m["order"].append(folder)
        write_meta(od, m)
    bump(f"esc:rooms:{os.path.basename(od)}")
    return entry


def rooms_probe_value(office_id):
    """Valor barato que muda quando as salas mudam (nomes das pastas + mtime do office.json)."""
    od = office_dir(office_id)
    try:
        mt = os.stat(meta_path(od)).st_mtime_ns
    except OSError:
        mt = 0
    return (tuple(sorted(_room_dirs(od))), mt)


# ============================================================ processos
# Regex do Arquipélago: variáveis de uma sessão Claude "mãe" que NÃO podem vazar para processos filhos
# (o servidor pode ter sido iniciado de dentro de um claude). Use core.clean_env() em todo Popen de claude.
ENV_DROP = re.compile(r"^(CLAUDECODE|AI_AGENT|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(ENTRYPOINT|EXECPATH|SESSION_\w*|"
                      r"CHILD_SESSION|MESSAGING_\w*|SSE_PORT|IDE_\w*))$")


def clean_env(extra=None) -> dict:
    env = {k: v for k, v in os.environ.items() if not ENV_DROP.match(k)}
    if extra:
        env.update({k: str(v) for k, v in extra.items()})
    return env


# git: ambiente e flags seguros para TUDO que o servidor roda (clone, init, status). Ver ARCH.md §Segurança.
GIT_ENV = {k: v for k, v in os.environ.items() if not k.startswith("GIT_") and not ENV_DROP.match(k)}
GIT_ENV.update(GIT_TERMINAL_PROMPT="0", GIT_OPTIONAL_LOCKS="0", LC_ALL="C", LANG="C",
               GIT_ASKPASS="/bin/false", SSH_ASKPASS="/bin/false", GIT_CONFIG_NOSYSTEM="1",
               GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=yes")
GIT_SAFE = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "color.ui=false",
            "-c", "credential.helper=", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always",
            "-c", "protocol.ssh.allow=always", "-c", "submodule.recurse=false", "-c", "core.pager=cat"]


def spawn(cmd, cwd=None) -> list:
    """Dispara um processo destacado (sem esperar). Com ESC_DRY_RUN=1 só loga."""
    cmd = [str(c) for c in cmd]
    if dry_run():
        log(f"[ESC_DRY_RUN] cwd={cwd or os.getcwd()} $ {shlex.join(cmd)}")
        return cmd
    subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
                     cwd=cwd, start_new_session=True)
    return cmd


def run_windows(exe: str, *args: str) -> list:
    """Roda um .exe do Windows com cwd=/mnt/c. Se o binfmt do WSLInterop estiver quebrado, lança via /init.
    Respeita ESC_DRY_RUN."""
    full = shutil.which(exe) or exe
    cwd = "/mnt/c" if os.path.isdir("/mnt/c") else None
    try:
        return spawn([full, *args], cwd=cwd)
    except OSError:
        return spawn(["/init", full, *args], cwd=cwd)


def to_windows_path(path: str) -> str:
    return subprocess.run(["wslpath", "-w", path], capture_output=True, text=True, check=True).stdout.strip()


def is_binary(head: bytes) -> bool:
    """NUL nos primeiros 8 KB ou texto que não decodifica em UTF-8 (tolerando um caractere cortado no fim)."""
    if b"\x00" in head[:8192]:
        return True
    try:
        head.decode("utf-8")
        return False
    except UnicodeDecodeError as e:
        return not (e.start >= len(head) - 3 and e.reason in ("unexpected end of data",))


# ============================================================ tempo real: long-poll (ARCH.md §Tempo real)
# Nada de SSE: o servidor é HTTP/1.0 (uma conexão por pedido) e o "ao vivo" é long-poll com etag/offset/versão.
# Regras: nenhum handler segura lock global enquanto espera; toda espera tem teto de tempo E de vagas; quem espera
# desiste cedo se o cliente foi embora (ctx.client_gone()). O ThreadingHTTPServer do server.py usa daemon_threads,
# então uma espera em curso nunca trava o Ctrl+C nem a porta.
BOOT_ID = f"{os.getpid()}-{int(time.time())}"
MAX_LONGPOLL = 32            # esperas simultâneas no servidor inteiro (todas as rotas somadas)
_slots_lock = threading.Lock()
_slots = {}                  # nome -> nº de esperas em curso
_slots_total = [0]


def clamp_wait(value, hi: float, lo: float = 0.0) -> float:
    """?wait=<s> da query → float em [lo, hi]; inválido/ausente → lo."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return lo
    if v != v:   # NaN
        return lo
    return max(lo, min(hi, v))


@contextmanager
def longpoll_slot(name: str, limit: int = 8):
    """Vaga de espera: `with core.longpoll_slot('frota', 8) as ok:` — ok=False quando `name` já tem `limit`
    esperas (ou o servidor já tem MAX_LONGPOLL): responda NA HORA (ex.: {"waited": false}) em vez de esperar.
    Não bloqueia nunca."""
    with _slots_lock:
        ok = _slots.get(name, 0) < limit and _slots_total[0] < MAX_LONGPOLL
        if ok:
            _slots[name] = _slots.get(name, 0) + 1
            _slots_total[0] += 1
    try:
        yield ok
    finally:
        if ok:
            with _slots_lock:
                _slots[name] -= 1
                _slots_total[0] -= 1


def longpoll_stats() -> dict:
    with _slots_lock:
        return {"total": _slots_total[0], "max": MAX_LONGPOLL, "by_name": {k: v for k, v in _slots.items() if v}}


class Notifier:
    """Contador de versão + Condition, para quem PRODUZ eventos (jobs, hooks...). bump() acorda as esperas.
        N = core.Notifier('claude:jobs')      # com nome: também vira canal do hub (/api/hub)
        N.bump()                               # algo mudou
        v = N.wait(since, timeout, gone=ctx.client_gone)   # devolve a versão atual (≠ since se mudou)
    """

    def __init__(self, name: str = None):
        self._cond = threading.Condition()
        self.version = 1
        self.name = name
        if name:
            _hub_register(name, self)

    def bump(self) -> int:
        with self._cond:
            self.version += 1
            self._cond.notify_all()
            v = self.version
        _hub_notify()
        return v

    def wait(self, since, timeout: float, gone=None, step: float = 1.0) -> int:
        """Espera version != since (até timeout s). `gone()` (ex. ctx.client_gone) é checado a cada `step` s,
        FORA do lock. Devolve a versão atual."""
        end = time.monotonic() + max(0.0, timeout)
        while True:
            with self._cond:
                if str(self.version) != str(since):
                    return self.version
                left = end - time.monotonic()
                if left <= 0:
                    return self.version
                self._cond.wait(min(step, left))
                if str(self.version) != str(since):
                    return self.version
            if gone is not None and gone():
                return self.version


# ---- hub: UM long-poll por aba para todos os canais (o navegador só abre 6 conexões por origem)
# Canal = nome → versão (int). Dois jeitos de mudar a versão:
#   empurrado: core.Notifier('nome').bump()  (quem produz o evento sabe quando mudou)
#   sondado:   core.channel('nome', probe=fn, interval=1.0) — a thread do hub chama fn() a cada `interval` s
#              ENQUANTO alguém observa o canal (≤ 30 s desde o último /api/hub que o citou) e sobe a versão
#              quando o valor devolvido muda (fn barata: etag, (size, inode) de um arquivo...)
#   canais com parâmetro: core.channel_prefix('claude:transcript:', factory) — factory(nome) → probe | None
_hub_cond = threading.Condition()
_hub_lock = threading.Lock()
_channels = {}               # nome -> _Channel
_prefixes = {}               # prefixo -> (factory, interval)
_hub_thread = [None]
HUB_WATCH_TTL = 30.0
HUB_MAX_CHANNELS = 512


class _Channel:
    __slots__ = ("name", "notifier", "probe", "interval", "last_probe", "value", "probed", "watched", "version_p")

    def __init__(self, name, notifier=None, probe=None, interval=1.0):
        self.name, self.notifier, self.probe, self.interval = name, notifier, probe, max(0.2, float(interval))
        self.last_probe, self.value, self.probed, self.watched, self.version_p = 0.0, None, False, 0.0, 1

    @property
    def version(self):
        return self.notifier.version if self.notifier else self.version_p


def _hub_register(name, notifier):
    with _hub_lock:
        ch = _channels.get(name)
        if ch:
            ch.notifier = notifier
        else:
            _channels[name] = _Channel(name, notifier=notifier)


def _hub_notify():
    with _hub_cond:
        _hub_cond.notify_all()


def channel(name: str, probe=None, interval: float = 1.0):
    """Registra (ou atualiza) um canal sondado. Devolve o nome. A versão começa em 1 e sobe a cada mudança do
    valor de probe(). Exceção no probe conta como valor 'erro' (não derruba a thread)."""
    with _hub_lock:
        ch = _channels.get(name)
        if ch:
            ch.probe, ch.interval = probe, max(0.2, float(interval))
        else:
            _channels[name] = _Channel(name, probe=probe, interval=interval)
    return name


def channel_prefix(prefix: str, factory, interval: float = 1.0) -> None:
    """Canais criados sob demanda: o 1º /api/hub que citar 'prefixo...' chama factory(nome) → probe (ou None =
    canal inválido, fica na versão 0)."""
    with _hub_lock:
        _prefixes[prefix] = (factory, interval)


def bump(name: str) -> None:
    """Sobe a versão de um canal sondado/avulso na mão (ex.: depois de uma ação que você sabe que mudou algo)."""
    with _hub_lock:
        ch = _channels.get(name)
        if not ch:
            ch = _channels[name] = _Channel(name)
        if ch.notifier:
            n = ch.notifier
        else:
            ch.version_p += 1
            n = None
    if n:
        n.bump()
    else:
        _hub_notify()


def _hub_channel(name, now):
    ch = _channels.get(name)
    if ch is None:
        for pre, (factory, interval) in _prefixes.items():
            if name.startswith(pre) and len(_channels) < HUB_MAX_CHANNELS:
                try:
                    probe = factory(name)
                except Exception as e:  # noqa: BLE001
                    log(f"[esc] hub: factory de {pre!r} falhou para {name!r}: {e!r}")
                    probe = None
                if probe is not None:
                    ch = _channels[name] = _Channel(name, probe=probe, interval=interval)
                break
    if ch is not None:
        ch.watched = now
    return ch


def hub_versions(names) -> dict:
    """{nome: versão} (0 = canal desconhecido). Marca os canais como observados."""
    now = time.monotonic()
    with _hub_lock:
        chans = {n: _hub_channel(n, now) for n in names}
    for ch in chans.values():   # 1ª observação de um canal sondado: linha de base já, sem esperar a thread
        if ch is not None and ch.probe and not ch.probed:
            _probe(ch)
    _hub_start()
    return {n: (ch.version if ch else 0) for n, ch in chans.items()}


def _probe(ch) -> bool:
    """Roda o probe de um canal; True se o valor mudou (a versão já subiu)."""
    try:
        val = ch.probe()
    except Exception as e:  # noqa: BLE001
        val = ("erro", repr(e))
    ch.last_probe = time.monotonic()
    changed = ch.probed and val != ch.value
    if changed:
        with _hub_lock:
            ch.version_p += 1
    ch.value, ch.probed = val, True
    return changed


def hub_wait(since: dict, timeout: float, gone=None) -> dict:
    """Espera até alguma versão diferir de `since` ({nome: versão}) ou timeout. Devolve {nome: versão}."""
    end = time.monotonic() + max(0.0, timeout)
    cur = hub_versions(since.keys())
    while all(str(cur.get(k)) == str(v) for k, v in since.items()):
        left = end - time.monotonic()
        if left <= 0:
            break
        with _hub_cond:
            _hub_cond.wait(min(1.0, left))
        if gone is not None and gone():
            break
        cur = hub_versions(since.keys())
    return cur


def _hub_loop():
    while True:
        time.sleep(0.25)
        now = time.monotonic()
        with _hub_lock:
            due = [ch for ch in _channels.values()
                   if ch.probe and now - ch.watched < HUB_WATCH_TTL and now - ch.last_probe >= ch.interval]
            stale = [k for k, ch in _channels.items() if not ch.notifier and now - ch.watched > 600
                     and any(k.startswith(p) for p in _prefixes)]
            for k in stale:          # canais de prefixo esquecidos (ex.: transcript de sessão fechada)
                _channels.pop(k, None)
        changed = False
        for ch in due:
            changed = _probe(ch) or changed
        if changed:
            _hub_notify()


def _hub_start():
    if _hub_thread[0] is None:
        with _hub_lock:
            if _hub_thread[0] is None:
                t = threading.Thread(target=_hub_loop, name="esc-hub", daemon=True)
                _hub_thread[0] = t
                t.start()
