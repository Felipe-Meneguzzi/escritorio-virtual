"""PACOTE funcionarios — backend "RH": funcionários = processos `claude -p` trabalhando numa sala (projeto).

Cópia ADAPTADA de /home/menegas/arquipelago/features/claude_jobs.py + _claude_common.py (nada é importado de lá).

Contrato completo em ARCH.md §Funcionários. Resumo:
    GET  /api/rh/config?office=                               → {max_func, rodando, budget, wall_s, modelos, modo, web, aviso, ...}
    POST /api/rh/contratar {office, sala, tarefa, modelo, nome?, confirmo:true} → 201 FUNC · 400 · 404 · 409 · 429
    GET  /api/rh/funcionarios?office=&sala=&wait=0..25&etag=  → {etag, rodando, max_func, funcionarios:[FUNC]}  (long-poll)
    GET  /api/rh/funcionarios/{fid}?office=                   → FUNC completo (resultado inteiro, turnos, equipe)
    GET  /api/rh/funcionarios/{fid}/feed?office=&offset=&wait=&quem= → {eventos:[EVT], offset, vivo}  (offset=-1 → últimos 120)
    POST /api/rh/funcionarios/{fid}/mensagem {office, texto}  → 202 FUNC · 409 {erro:"ocupado"} (ou {enfileirado:true} c/ ESC_FILA=1)
    POST /api/rh/funcionarios/{fid}/dispensar {office}        → {ok}   (SIGTERM no grupo → SIGKILL em 5 s)
    POST /api/rh/funcionarios/{fid}/arquivar {office}         → {ok}   (move para .escritorio/rh/.arquivo — nada é apagado)
    GET  /api/rh/visitantes?office=                           → {visitantes:[…]}  (sessões interativas vivas dentro das salas;
                                                                 SÓ LEITURA — nunca --resume)
    GET  /api/rh/sala_alerta?office=&sala=                    → {alertas:[str]}  (clone/externa com CLAUDE.md/AGENTS.md/.claude)
Canal do hub: 'esc:staff:<office>' (core.Notifier). Registro em <escritório>/.escritorio/rh/<fid>/:
    meta.json (estado), out.ndjson (stream-json cru, append por turno), err.log, eventos.ndjson (EVT normalizados, seq).

Fatos do stream (medidos na viabilidade, claude 2.1.285):
- a ferramenta de subagente chega como 'Agent' (o init lista 'Task'); subagentes são ASSÍNCRONOS: o tool_result
  "Async agent launched" chega em ~20 ms e NÃO marca o fim;
- ciclo do subagente em system/task_started → task_progress (texto pronto do balão) → task_updated/task_notification;
- mensagens internas do subagente trazem parent_tool_use_id = tool_use_id do Agent que o criou;
- o MESMO processo emite vários system/init e vários result (result_index 0..n) — nunca zere o estado no init;
  fim do trabalho = SAÍDA DO PROCESSO; resposta = result de maior result_index;
- total_cost_usd é CUMULATIVO na sessão retomada: custo_total = o do último result; custo_turno = diferença. NUNCA somar.

Segurança (regras invioláveis):
- argv em LISTA (sem shell), prompt por STDIN; `--setting-sources user --strict-mcp-config --disable-slash-commands`
  (hooks/.mcp.json/settings de repositório clonado NÃO rodam; skills do usuário desligadas);
- `--disallowedTools WebFetch,WebSearch` por padrão (ESC_WEB=1 libera);
- cwd = realpath da sala validado dentro do escritório; env saneado (core.clean_env);
- limites: ESC_MAX_FUNC processos, ESC_WALL s de parede, ESC_BUDGET por turno (vale por processo), ESC_BUDGET_SESSAO
  recusa mensagem quando o custo acumulado passa dele; ESC_TURNS (--max-turns);
- --resume só do session_id do PRÓPRIO registro e só se ele NÃO estiver vivo (live_session_ids lê SÓ sessions/*.json;
  nunca *.key; messagingSocketPath nem é repassado);
- modo por ESC_MODO (padrão bypassPermissions = "tudo liberado na sala" — BYPASS NÃO É SANDBOX: a UI avisa e pede
  confirmação). Repassado em TODO turno (não fica salvo na sessão).

Testes sem gastar tokens: ESC_DRY_RUN=1 escreve um stream-json SINTÉTICO (multiagente) em vez de rodar o claude
(ESC_RH_REAL=1 roda o claude de verdade mesmo assim). Marcadores na tarefa, só no dry-run: '#lento', '#erro',
'#bloqueia', '#limite'.
"""
import glob
import hashlib
import json
import os
import re
import secrets
import shutil
import signal
import subprocess
import threading
import time
import unicodedata
import uuid

import esc_core as core  # core.ROOT/core.PORT mudam em runtime: leia sempre como atributo

# ------------------------------------------------------------------ configuração (env)
MODELS = ("haiku", "sonnet", "opus")
MODES = ("bypassPermissions", "auto", "acceptEdits", "default", "plan")   # default/plan: só para testes
TASK_MAX = 8000
MSG_MAX = 8000
FID_RE = re.compile(r"^f\d{14}[0-9a-f]{4}$")                 # 'f' + yyyymmddHHMMSS + 4 hex
TASK_ID_RE = re.compile(r"^[A-Za-z0-9_-]{4,64}$")            # task_id do subagente (17 hex na viabilidade)
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
TOOL_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*(\([^()\x00-\x1f]{0,80}\))?$")
SUB_KEEP_S = 30          # subagentes terminados continuam na lista por 30 s (animação de saída)
FEED_TAIL = 120
FEED_MAX = 400
AGENT_TOOLS = ("Agent", "Task")


def _env_float(name, default, lo, hi):
    try:
        v = float(os.environ.get(name) or default)
    except ValueError:
        v = default
    return min(max(v, lo), hi)


def _env_int(name, default, lo, hi):
    try:
        v = int(os.environ.get(name) or default)
    except ValueError:
        v = default
    return min(max(v, lo), hi)


def _max_func():
    return max(1, int(getattr(core, "MAX_FUNC", 4) or 4))


def _budget():
    return f"{_env_float('ESC_BUDGET', 1.0, 0.01, 50.0):.2f}"


def _budget_sessao():
    return _env_float("ESC_BUDGET_SESSAO", 5.0, 0.05, 500.0)


def _wall():
    return _env_int("ESC_WALL", 1800, 30, 24 * 3600)


def _turns():
    return _env_int("ESC_TURNS", 80, 1, 500)


def _max_sala():
    return _env_int("ESC_MAX_POR_SALA", 3, 1, 12)


def _mode():
    m = os.environ.get("ESC_MODO") or "bypassPermissions"
    return m if m in MODES else "bypassPermissions"


def _web():
    return os.environ.get("ESC_WEB", "") not in ("", "0", "false", "no")


def _fila():
    return os.environ.get("ESC_FILA", "") not in ("", "0", "false", "no")


def _allowed_tools():
    """ESC_ALLOWED_TOOLS (vírgulas) → --allowedTools. Pensado para testes em modo default (ex.: Read,Glob,Grep,Agent)."""
    raw = os.environ.get("ESC_ALLOWED_TOOLS") or ""
    out = []
    for t in raw.split(","):
        t = t.strip()
        if t and TOOL_RE.match(t) and t not in out:
            out.append(t)
    return out[:24]


def _dry():
    return core.dry_run() and os.environ.get("ESC_RH_REAL", "") in ("", "0", "false", "no")


def _sub_env():
    return {
        "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS": _env_int("ESC_SUBS_PAR", 3, 1, 8),
        "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH": 1,          # árvore rasa = NPCs legíveis
        "CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION": _env_int("ESC_SUBS_SESSAO", 12, 1, 64),
    }


MODE_TEXT = {
    "bypassPermissions": "tudo liberado na sala (sem pedir permissão)",
    "auto": "liberado com juízo (classificador de segurança do Claude)",
    "acceptEdits": "edita arquivos sem pedir; comandos precisam de permissão (serão bloqueados)",
    "default": "só o que estiver na lista de ferramentas permitidas (teste)",
    "plan": "só planeja, não mexe em nada",
}
AVISO = ("Funcionários executam comandos na pasta da sala SEM pedir permissão. Isso não é uma caixa de areia: um "
         "funcionário pode ler e escrever qualquer arquivo que o seu usuário alcança, rodar qualquer comando e até chamar "
         "a própria API do Escritório (contratar colegas em outras salas, dentro do limite). Hooks, .mcp.json, "
         "settings, agentes e skills do repositório NÃO são carregados, mas o CLAUDE.md/AGENTS.md do projeto é lido "
         "como instrução: num repositório de terceiros ele pode mandar o funcionário fazer coisas ruins. Seus plugins e "
         "agentes de usuário também vêm junto. Só contrate para projetos em que você confia.")
# arquivos que o claude lê como instrução mesmo com --setting-sources user (ou que merecem desconfiança num repo alheio)
INSTR_FILES = ("CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", ".claude")
ERR_TEXT = {
    "error_max_budget_usd": "teto de gasto do turno atingido",
    "error_max_turns": "limite de passos do turno atingido",
    "error_during_execution": "erro durante a execução",
    "error_max_structured_output_retries": "erro de formato na resposta",
}

# nomes genéricos (nenhum personagem da série!) — funcionários ganham sobrenome, subagentes só o primeiro nome
FIRST = ["Ana", "Bruno", "Carla", "Diego", "Elisa", "Fábio", "Gabriela", "Heitor", "Igor", "Júlia", "Lucas", "Marina",
         "Nicolas", "Olívia", "Paulo", "Renata", "Sérgio", "Tatiana", "Vítor", "Yara", "Caio", "Débora", "Lívia",
         "Márcio", "Priscila", "Rafael", "Sílvia", "Tiago", "Vanessa", "Wagner", "Beatriz", "Otávio", "Luana",
         "Rodrigo", "Célia", "Fernanda", "Gustavo", "Irene", "Leandro", "Mirela", "Norberto", "Rosana", "Túlio"]
LAST = ["Almeida", "Barbosa", "Cardoso", "Duarte", "Esteves", "Figueiredo", "Gouveia", "Holanda", "Lacerda", "Macedo",
        "Nogueira", "Pacheco", "Queiroz", "Rezende", "Siqueira", "Tavares", "Valadares", "Xavier", "Moreira", "Bittencourt"]

SYS_TMPL = (
    "Você é um funcionário do escritório {escritorio}, trabalhando na sala do projeto {sala} (pasta atual). "
    "Trabalhe SEMPRE em equipe: divida a tarefa e delegue as partes independentes a subagentes com a ferramenta Agent "
    "(várias chamadas Agent na MESMA mensagem para rodarem em paralelo; no máximo {par} de uma vez). Dê a cada "
    "subagente uma description curta (≤5 palavras, vira o crachá dele) e um prompt autocontido pedindo resposta CURTA. "
    "Não repita o trabalho delegado; faça você mesmo só o que for rápido ou sequencial. Não crie subagente para tarefa "
    "trivial de 1 ferramenta. Ao delegar, escreva 1 linha dizendo o que cada colega vai fazer. Se receber 'Concurrent "
    "subagent limit reached', espere um terminar. Não saia da pasta do projeto. Termine com um resumo de até 5 linhas: "
    "o que foi feito, arquivos alterados e pendências. Responda em português do Brasil.")

# ------------------------------------------------------------------ estado em memória
_lock = threading.RLock()        # protege FUNCS/RT/EVIDX; NUNCA segurado durante espera de long-poll
FUNCS = {}                       # fid -> meta (o que vai para o meta.json)
RT = {}                          # fid -> estado do scanner/processo (não persiste; reconstruído no boot)
EVIDX = {}                       # fid -> [byte offset da linha do evento seq=i] (índice do eventos.ndjson)
FEEDN = {}                       # fid -> core.Notifier() (sem nome) — acorda quem espera no feed
_notifiers = {}                  # office -> core.Notifier('esc:staff:<office>')
_booted = False


def claude_bin():
    return shutil.which("claude") or os.path.expanduser("~/.local/bin/claude")


def _now():
    return time.time()


def _notifier(office):
    with _lock:
        n = _notifiers.get(office)
        if n is None:
            n = _notifiers[office] = core.Notifier(f"esc:staff:{office}")
        return n


def _bump(office):
    _notifier(office).bump()


def _feed_n(fid):
    with _lock:
        n = FEEDN.get(fid)
        if n is None:
            n = FEEDN[fid] = core.Notifier()
        return n


def _cut(s, n):
    s = s if isinstance(s, str) else ("" if s is None else str(s))
    return s if len(s) <= n else s[: n - 1] + "…"


def _clean_text(s, n):
    """Remove controles (menos \\n e \\t) e corta."""
    s = unicodedata.normalize("NFC", s if isinstance(s, str) else "")
    s = "".join(ch for ch in s if ch in "\n\t" or unicodedata.category(ch)[0] != "C")
    return s[:n]


def _fdir(meta):
    return os.path.join(meta["_od"], core.META_DIR, "rh", meta["id"])


_io_locks = {}                   # fid -> Lock só da GRAVAÇÃO do meta.json (nunca segura o _lock)
_io_guard = threading.Lock()
_written = {}                    # fid -> versão do último retrato gravado


def _snap(meta):
    """Retrato do meta.json (SOB o _lock): (fid, caminho, bytes, versão). A gravação pode ser feita depois, fora do lock."""
    d = _fdir(meta)
    ver = meta["_ver"] = meta.get("_ver", 0) + 1
    data = {k: v for k, v in meta.items() if not k.startswith("_")}
    return meta["id"], os.path.join(d, "meta.json"), json.dumps(data, ensure_ascii=False).encode(), ver


def _write_snap(snap):
    """Grava um retrato (atomic_write com fsync). Retrato mais velho que o já gravado é descartado."""
    fid, path, data, ver = snap
    with _io_guard:
        lk = _io_locks.setdefault(fid, threading.Lock())
    with lk:
        if _written.get(fid, 0) >= ver or not os.path.isdir(os.path.dirname(path)):
            return
        core.atomic_write(path, data, mode=0o600)
        _written[fid] = ver


def _save(meta):
    """Gravação síncrona (eventos raros: contratar, fim de turno, dispensar...). O scanner usa _snap + _write_snap."""
    _write_snap(_snap(meta))


def _pick_name(seed=None, avoid=()):
    r = secrets.randbelow if seed is None else None
    if seed is None:
        for _ in range(12):
            n = f"{FIRST[r(len(FIRST))]} {LAST[r(len(LAST))]}"
            if n not in avoid:
                return n
        return n
    h = int(hashlib.sha1(str(seed).encode()).hexdigest(), 16)
    for i in range(len(FIRST)):
        n = FIRST[(h + i * 7) % len(FIRST)]
        if n not in avoid:
            return n
    return FIRST[h % len(FIRST)]


# ------------------------------------------------------------------ processos e sessões vivas (só leitura do ~/.claude)
CLAUDE_HOME = os.path.abspath(os.path.expanduser(os.environ.get("ESC_CLAUDE_DIR") or "~/.claude"))
SESSIONS_DIR = os.path.join(CLAUDE_HOME, "sessions")
_SESSION_KEYS = ("pid", "sessionId", "cwd", "name", "status", "startedAt", "updatedAt", "entrypoint", "procStart", "kind")


def pid_start(pid):
    """Campo 22 de /proc/<pid>/stat (starttime em ticks), parseado depois do último ')'. None se não existe."""
    try:
        with open(f"/proc/{int(pid)}/stat", "rb") as f:
            rest = f.read().rsplit(b")", 1)[1].split()
        return int(rest[19])
    except (OSError, ValueError, IndexError, TypeError):
        return None


def _cmdline(pid):
    try:
        with open(f"/proc/{int(pid)}/cmdline", "rb") as f:
            return [a for a in f.read().split(b"\0") if a]
    except (OSError, ValueError, TypeError):
        return None


def _looks_claude(pid, argv):
    if os.path.basename(argv[0]) == b"claude":
        return True
    if os.path.basename(argv[0]) in (b"node", b"nodejs", b"bun", b"deno"):
        for a in argv[1:3]:
            base = os.path.basename(a)
            if base == b"claude" or (base == b"cli.js" and b"/claude" in a):
                return True
    try:
        exe = os.readlink(f"/proc/{pid}/exe")
        return "/claude/" in exe or os.path.basename(exe) == "claude"
    except OSError:
        return False


def is_claude_pid(pid, proc_start=None):
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    argv = _cmdline(pid)
    if not argv or not _looks_claude(pid, argv):
        return False
    if proc_start not in (None, ""):
        try:
            return pid_start(pid) == int(proc_start)
        except (TypeError, ValueError):
            return False
    return True


def group_members(pgid, since=None):
    out = []
    try:
        names = os.listdir("/proc")
    except OSError:
        return out
    for n in names:
        if not n.isdigit():
            continue
        try:
            with open(f"/proc/{n}/stat", "rb") as f:
                rest = f.read().rsplit(b")", 1)[1].split()
            if int(rest[2]) != pgid:
                continue
            if since is not None and int(rest[19]) < since:
                continue
            out.append(int(n))
        except (OSError, ValueError, IndexError):
            continue
    return out


_sess_lock = threading.Lock()
_sess_cache = {"t": 0.0, "list": []}


def live_sessions(max_age=1.5):
    """Sessões vivas do Claude Code (cópias com whitelist de chaves). Lê SÓ sessions/*.json — os *.key do mesmo
    diretório são credenciais: nunca abertos. messagingSocketPath nunca sai daqui."""
    now = time.monotonic()
    with _sess_lock:
        if now - _sess_cache["t"] <= max_age:
            return [dict(s) for s in _sess_cache["list"]]
    out = []
    for path in glob.glob(os.path.join(SESSIONS_DIR, "*.json")):
        try:
            with open(path, "rb") as f:
                d = json.loads(f.read(64 * 1024))
        except (OSError, ValueError):
            continue
        if not isinstance(d, dict) or not isinstance(d.get("pid"), int) or not isinstance(d.get("sessionId"), str):
            continue
        if not is_claude_pid(d["pid"], d.get("procStart")):
            continue
        out.append({k: d.get(k) for k in _SESSION_KEYS})
    with _sess_lock:
        _sess_cache.update(t=time.monotonic(), list=out)
    return [dict(s) for s in out]


def live_session_ids():
    return {s["sessionId"] for s in live_sessions()}


# ------------------------------------------------------------------ leitura incremental de JSONL (de _claude_common)
LINE_MAX = 4 * 1024 * 1024
READ_CAP = 512 * 1024


def _find_nl(f, frm, size, step=256 * 1024):
    pos = frm
    while pos < size:
        f.seek(pos)
        b = f.read(min(step, size - pos))
        if not b:
            return None
        i = b.find(b"\n")
        if i >= 0:
            return pos + i
        pos += len(b)
    return None


def scan_lines(path, offset, max_bytes=READ_CAP):
    """Linhas COMPLETAS a partir de offset → (items [(pos, obj)], novo_offset, reset). Linha pela metade fica para a
    próxima; linha gigante (> LINE_MAX) é pulada."""
    st = os.stat(path)
    size, reset = st.st_size, False
    if offset > size:
        offset, reset = 0, True
    items = []
    with open(path, "rb") as f:
        pos = offset
        budget = max_bytes
        while pos < size and budget > 0:
            f.seek(pos)
            buf = f.read(min(budget, size - pos))
            nl = buf.rfind(b"\n")
            if nl < 0:
                end = _find_nl(f, pos + len(buf), size)
                if end is None:
                    break
                if end - pos <= LINE_MAX:
                    f.seek(pos)
                    _parse_chunk(f.read(end - pos + 1), pos, items)
                pos = end + 1
                break
            chunk = buf[: nl + 1]
            _parse_chunk(chunk, pos, items)
            pos += len(chunk)
            budget -= len(chunk)
            if nl + 1 < len(buf):
                break
    return items, pos, reset


def _parse_chunk(chunk, base, items):
    pos = base
    for raw in chunk.split(b"\n")[:-1]:
        here, pos = pos, pos + len(raw) + 1
        if not raw.strip():
            continue
        try:
            items.append((here, json.loads(raw)))
        except ValueError:
            continue


# ------------------------------------------------------------------ alvo/descrição de ferramentas
def _rel(p, cwd):
    if isinstance(p, str) and cwd and (p == cwd or p.startswith(cwd.rstrip("/") + "/")):
        return os.path.relpath(p, cwd)
    return p


def _target(inp, cwd):
    """Alvo curto e legível de uma ferramenta (caminho relativo à sala, comando, padrão...) ≤ 120."""
    if not isinstance(inp, dict):
        return None
    for k in ("file_path", "notebook_path"):
        if isinstance(inp.get(k), str):
            return _cut(_rel(inp[k], cwd), 120)
    if isinstance(inp.get("command"), str):
        return _cut(" ".join(inp["command"].split()), 120)
    if isinstance(inp.get("pattern"), str):
        extra = f"  em {_rel(inp['path'], cwd)}" if isinstance(inp.get("path"), str) else ""
        return _cut(inp["pattern"] + extra, 120)
    if isinstance(inp.get("todos"), list):
        return f"{len(inp['todos'])} itens"
    for k in ("description", "url", "query", "skill", "prompt", "path", "subject", "name"):
        if isinstance(inp.get(k), str) and inp[k]:
            return _cut(" ".join(inp[k].split()), 120)
    return None


def _result_text(c, n=300):
    if isinstance(c, list):
        parts = []
        for b in c:
            if isinstance(b, dict):
                if b.get("type") == "text":
                    parts.append(b.get("text") or "")
                elif b.get("type") == "image":
                    parts.append("[imagem]")
        c = "\n".join(parts)
    if not isinstance(c, str):
        c = "" if c is None else str(c)
    lines = c.strip("\n").split("\n")
    more = len(lines) - 4
    return _cut("\n".join(lines[:4]) + (f"\n… (+{more} linhas)" if more > 0 else ""), n)


# ------------------------------------------------------------------ eventos normalizados (EVT)
def _ev_path(meta):
    return os.path.join(_fdir(meta), "eventos.ndjson")


def _build_idx(path, pos=0, idx=None):
    """Lê o eventos.ndjson a partir de pos e continua o índice. Para numa linha incompleta. → (idx, pos)."""
    idx = [] if idx is None else idx
    try:
        with open(path, "rb") as f:
            f.seek(pos)
            for raw in f:
                if not raw.endswith(b"\n"):
                    break
                try:
                    o = json.loads(raw)
                    if isinstance(o, dict) and o.get("seq") == len(idx):
                        idx.append(pos)
                except ValueError:
                    pass
                pos += len(raw)
    except OSError:
        pass
    return idx, pos


def _publish_idx(meta, idx):
    EVIDX[meta["id"]] = idx
    if meta.get("seq", 0) != len(idx):
        meta["seq"] = len(idx)
    return idx


def _warm_index(fid):
    """Monta o índice FORA do _lock (eventos.ndjson de dezenas de MB depois de um reinício não trava as rotas) e
    publica sob o lock, completando o que foi acrescentado no meio tempo."""
    with _lock:
        meta = FUNCS.get(fid)
        if meta is None or fid in EVIDX:
            return
        path = _ev_path(meta)
    idx, pos = _build_idx(path)
    with _lock:
        if FUNCS.get(fid) is not meta or fid in EVIDX:
            return
        idx, _pos = _build_idx(path, pos, idx)             # só a cauda (normalmente nada)
        _publish_idx(meta, idx)


def _ev_index(fid):
    """Índice seq → offset do eventos.ndjson (appends mantêm). Chamado SOB o lock; normalmente já está aquecido por
    _warm_index (boot/feed) — construir aqui é só o caminho de reserva."""
    idx = EVIDX.get(fid)
    if idx is not None:
        return idx
    meta = FUNCS[fid]
    return _publish_idx(meta, _build_idx(_ev_path(meta))[0])


def _emit(meta, quem, tipo, **kw):
    """Acrescenta um EVT ao eventos.ndjson (seq monotônico). SOB o lock."""
    fid = meta["id"]
    rt = RT.get(fid)
    if rt is not None and rt.get("silent"):
        return None
    idx = _ev_index(fid)
    ev = {"seq": len(idx), "ts": round(_now(), 3), "quem": quem, "tipo": tipo, **kw}
    path = _ev_path(meta)
    data = (json.dumps(ev, ensure_ascii=False) + "\n").encode("utf-8")
    try:
        with open(path, "ab") as f:
            pos = f.tell()
            f.write(data)
    except OSError as e:
        core.log(f"[rh] não gravei evento de {fid}: {e!r}")
        return None
    idx.append(pos)
    meta["seq"] = len(idx)
    if rt is not None:
        rt["feed_dirty"] = True
    return ev


def _read_events(meta, start, limit, quem=None):
    """Eventos com seq ≥ start (até limit). → (eventos, próximo offset). SOB o lock só o índice."""
    fid = meta["id"]
    if fid not in EVIDX:
        _warm_index(fid)
    with _lock:
        idx = list(_ev_index(fid))
    n = len(idx)
    tail = start < 0
    if tail:
        start = max(0, n - (FEED_TAIL if not quem else FEED_TAIL * 6))
    if start >= n:
        return [], n
    out = []
    nxt = start
    try:
        with open(_ev_path(meta), "rb") as f:
            f.seek(idx[start])
            for raw in f:
                try:
                    ev = json.loads(raw)
                except ValueError:
                    break
                if not isinstance(ev, dict) or not isinstance(ev.get("seq"), int) or ev["seq"] >= n:
                    break
                nxt = ev["seq"] + 1
                if quem and ev.get("quem") != quem:
                    continue
                out.append(ev)
                if len(out) >= limit:
                    break
    except OSError:
        return [], start
    if quem and tail:
        out = out[-FEED_TAIL:]
    return out, nxt


# ------------------------------------------------------------------ públicos
def _pub_sub(s):
    return {k: s.get(k) for k in ("id", "tool_use_id", "pai", "funcionario", "nome", "descricao", "tipo", "profundidade",
                                  "status", "atividade", "uso", "resumo", "inicio", "fim")}


def _public(meta, full=False):
    now = _now()
    res = meta.get("resultado")
    if res and not full:
        res = dict(res)
        res["texto"] = _cut(res.get("texto") or "", 600)
    subs = list((meta.get("subs") or {}).values())
    vivos = [s for s in subs if s.get("status") == "trabalhando" or now - (s.get("fim") or now) < SUB_KEEP_S]
    j = {"id": meta["id"], "nome": meta.get("nome"), "sala": meta.get("sala"), "sala_nome": meta.get("sala_nome"),
         "tarefa": _cut(meta.get("tarefa") or "", 300), "modelo": meta.get("modelo"), "modo": meta.get("modo"),
         "modelos_reais": meta.get("modelos_reais") or [], "status": meta.get("status"),
         "session_id": meta.get("session_id"), "atividade": meta.get("atividade"),
         "custo_total": round(meta.get("custo_total") or 0, 6), "custo_turno": round(meta.get("custo_turno") or 0, 6),
         "turnos": len(meta.get("turns") or []), "inicio": meta.get("inicio"), "fim": meta.get("fim"),
         "resultado": res, "subagentes": [_pub_sub(s) for s in sorted(vivos, key=lambda s: s.get("inicio") or 0)],
         "equipe_total": len(subs), "seq": meta.get("seq", 0), "fila": bool(meta.get("fila")),
         "budget": meta.get("budget")}
    if meta.get("erro"):
        j["erro"] = meta["erro"]
    if full:
        j["tarefa"] = meta.get("tarefa")
        j["equipe"] = [_pub_sub(s) for s in sorted(subs, key=lambda s: s.get("inicio") or 0)]
        j["historico"] = [{k: t.get(k) for k in ("prompt", "inicio", "fim", "status", "custo_turno", "modo", "modelo")}
                          for t in meta.get("turns") or []]
    return j


def _running(meta):
    return meta.get("status") in ("trabalhando", "esperando_equipe", "contratando")


def _running_count():
    return sum(1 for m in FUNCS.values() if _running(m))


# ------------------------------------------------------------------ argv / turno
def build_argv(meta, resume=None, new_session=None):
    """argv do turno (lista, sem shell). O prompt NÃO entra aqui: vai por stdin."""
    mode, model = meta["modo"], meta["modelo"]
    if mode not in MODES or model not in MODELS:          # defesa em profundidade
        raise ValueError("opção fora da whitelist")
    sysp = SYS_TMPL.format(escritorio=meta.get("office_nome") or meta["office"], sala=meta.get("sala_nome") or meta["sala"],
                           par=_sub_env()["CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS"])
    argv = [claude_bin(), "-p", "--output-format", "stream-json", "--verbose"]
    if mode == "bypassPermissions":
        argv += ["--dangerously-skip-permissions"]         # forma canônica do bypass (não pede nada em -p)
    else:
        argv += ["--permission-mode", mode]
    argv += ["--setting-sources", "user", "--strict-mcp-config", "--disable-slash-commands",
             "--model", model, "--max-budget-usd", meta.get("budget") or _budget(), "--max-turns", str(_turns()),
             "--append-system-prompt", sysp]
    if resume:
        if not UUID_RE.match(resume):
            raise ValueError("session_id inválido")
        argv += ["--resume", resume]
    elif new_session:
        if not UUID_RE.match(new_session):
            raise ValueError("session_id inválido")
        argv += ["--session-id", new_session]
    if not _web():
        argv += ["--disallowedTools", "WebFetch,WebSearch"]   # variádico: um argumento só, antes do --allowedTools
    tools = _allowed_tools()
    if tools:
        argv += ["--allowedTools", *tools]
    return argv


def _new_rt(offset):
    return {"pos": offset, "cancel": False, "reason": None, "proc": None, "silent": False, "silent_until": 0,
            "pend": {}, "tu_owner": {}, "tools": {}, "sub_by_tu": {}, "best": None, "best_idx": -1, "denied": [],
            "awaiting": False, "feed_dirty": False, "last_cost": None}


def _start_turn(meta, prompt, resume=None):
    """SOB o lock. Dispara o processo (ou o escritor sintético do dry-run) e grava o meta."""
    fid = meta["id"]
    cwd = core.room_dir(meta["office"], meta["sala"])     # antes de mexer no estado (HttpError se a sala sumiu)
    meta["_cwd"] = cwd
    d = _fdir(meta)
    out_path = os.path.join(d, "out.ndjson")
    with open(out_path, "ab"):
        pass
    offset = os.path.getsize(out_path)
    new_sid = None
    if not resume:
        new_sid = str(uuid.uuid4())
        meta["session_id"] = new_sid
        meta.setdefault("sid_origem", new_sid)      # gerado AQUI, nunca pelo stream (_fold não toca): é o que o --resume usa
    meta["modo"] = _mode()
    meta["budget"] = _budget()
    argv = build_argv(meta, resume=resume, new_session=new_sid)
    turn = {"prompt": prompt[:300], "inicio": _now(), "fim": None, "pid": None, "procStart": None, "exit": None,
            "offset": offset, "modo": meta["modo"], "modelo": meta["modelo"], "session_id": resume or new_sid,
            "custo_antes": meta.get("custo_total") or 0.0, "custo_turno": None, "status": None, "result": None}
    meta.setdefault("turns", []).append(turn)
    meta["status"] = "trabalhando"
    meta["custo_turno"] = 0.0
    meta["fim"] = None
    meta.pop("erro", None)
    meta["atividade"] = {"tipo": "pensando", "ferramenta": None, "alvo": None, "texto": "lendo a tarefa…", "ts": _now()}
    meta["scan_pos"] = offset
    RT[fid] = _new_rt(offset)
    n = len(meta["turns"])
    _emit(meta, fid, "turno_inicio", prompt=_cut(prompt, 300), turno=n)
    if _dry():
        core.log(f"[rh][dry-run] {fid} cwd={cwd} $ {' '.join(a if len(a) < 60 else a[:57] + '…' for a in argv[1:])}")
        threading.Thread(target=_dry_writer, args=(fid, out_path, prompt, resume or new_sid), daemon=True,
                         name=f"rh-dry-{fid}").start()
    else:
        with open(out_path, "ab") as out, open(os.path.join(d, "err.log"), "ab") as err:
            p = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.PIPE, stdout=out, stderr=err,
                                 start_new_session=True, close_fds=True, env=core.clean_env(_sub_env()))
        try:
            p.stdin.write(prompt.encode("utf-8"))
            p.stdin.close()
        except OSError:
            pass
        turn["pid"], turn["procStart"] = p.pid, pid_start(p.pid)
        RT[fid]["proc"] = p
        core.log(f"[rh] {fid} ({meta.get('nome')}) pid {p.pid} na sala {meta['sala']!r}, modo {meta['modo']}")
        threading.Thread(target=_watch_child, args=(fid, p), daemon=True, name=f"rh-{fid}").start()
    _save(meta)


def _watch_child(fid, p):
    try:
        code = p.wait(timeout=_wall())
    except subprocess.TimeoutExpired:
        cancel(fid, reason=f"tempo máximo do turno ({_wall() // 60} min)")
        code = p.wait()
    _finish(fid, code)


def _watch_proc(fid, pid, ps, started):
    """Registro reatado depois de um reinício: o processo não é filho deste servidor — vigia por /proc."""
    while pid_start(pid) == ps:
        if _now() - (started or _now()) > _wall() and not RT.get(fid, {}).get("cancel"):
            cancel(fid, reason=f"tempo máximo do turno ({_wall() // 60} min)")
        time.sleep(1)
    _finish(fid, None)


# ------------------------------------------------------------------ dobra do stream-json (estado + EVT)
def _set_act(meta, quem, act):
    act["ts"] = round(_now(), 3)
    if quem == meta["id"]:
        meta["atividade"] = act
    else:
        s = (meta.get("subs") or {}).get(quem)
        if s is not None and s.get("status") == "trabalhando":
            prev = s.get("atividade") or {}
            if act.get("tipo") == "ferramenta" and prev.get("ferramenta") == act.get("ferramenta") and prev.get("texto") \
                    and not act.get("texto"):
                act["texto"] = prev["texto"]
            s["atividade"] = act


def _sub_status(st):
    return {"completed": "concluido", "failed": "falhou", "killed": "interrompido", "stopped": "interrompido",
            "cancelled": "interrompido", "error": "falhou"}.get(str(st or ""))


def _fold(meta, rt, obj):
    """Um evento do stream → estado do funcionário/subagentes + EVT. SOB o lock. Nunca levanta (o chamador protege)."""
    fid = meta["id"]
    if not isinstance(obj, dict):
        return False
    t, st = obj.get("type"), obj.get("subtype")
    cwd = meta.get("_cwd")
    sid = obj.get("session_id")
    changed = False
    if isinstance(sid, str) and UUID_RE.match(sid) and meta.get("session_id") != sid:
        if meta.get("sid_origem") and sid != meta["sid_origem"]:
            core.log(f"[rh] {fid}: o stream trouxe outro session_id ({sid}); o --resume continua preso a sid_origem")
        meta["session_id"] = sid
        if meta.get("turns"):
            meta["turns"][-1]["session_id"] = sid
        changed = True
    ptu = obj.get("parent_tool_use_id")
    quem = fid
    if ptu:
        quem = rt["sub_by_tu"].get(ptu) or rt["tu_owner"].get(ptu) or fid

    if t == "system":
        if st == "init":
            m = obj.get("model")
            if isinstance(m, str) and m and m not in (meta.get("modelos_reais") or []):
                meta.setdefault("modelos_reais", []).append(m[:60])
            rt["awaiting"] = False
            return True
        if st == "task_started":
            tid, tu = obj.get("task_id"), obj.get("tool_use_id")
            if not isinstance(tid, str) or not TASK_ID_RE.match(tid):
                return changed
            subs = meta.setdefault("subs", {})
            if tid in subs:
                return changed
            pend = rt["pend"].pop(tu, None) or {}
            owner = rt["tu_owner"].get(tu) or fid
            irmaos = set()                               # nomes em uso no escritório (subs vivos + funcionários)
            for m in FUNCS.values():
                if m.get("office") == meta.get("office") and m.get("status") != "dispensado":
                    irmaos.add((m.get("nome") or "").split(" ")[0])
                    irmaos |= {x.get("nome") for x in (m.get("subs") or {}).values() if x.get("status") == "trabalhando"}
            desc = _clean_text(obj.get("description") or pend.get("descricao") or "subagente", 80)
            sub = {"id": tid, "tool_use_id": tu if isinstance(tu, str) else None,
                   "pai": owner if owner != fid else fid, "funcionario": fid,
                   "nome": _pick_name(tid, avoid=irmaos),
                   "descricao": desc, "tipo": _cut(obj.get("subagent_type") or pend.get("tipo") or "general-purpose", 40),
                   "profundidade": obj.get("spawn_depth") if isinstance(obj.get("spawn_depth"), int) else 1,
                   "status": "trabalhando", "atividade": {"tipo": "chegando", "ferramenta": None, "alvo": None,
                                                          "texto": "chegando…", "ts": round(_now(), 3)},
                   "uso": None, "resumo": None, "inicio": round(_now(), 3), "fim": None, "prompt": _cut(obj.get("prompt") or pend.get("prompt") or "", 600)}
            subs[tid] = sub
            if isinstance(tu, str):
                rt["sub_by_tu"][tu] = tid
            _emit(meta, tid, "sub_entrou", sub=_pub_sub(sub))
            if owner == fid:
                _set_act(meta, fid, {"tipo": "ferramenta", "ferramenta": "Agent", "alvo": desc, "texto": f"delegou: {desc}"})
            rt["awaiting"] = False
            return True
        if st == "task_progress":
            s = (meta.get("subs") or {}).get(obj.get("task_id"))
            if not s or s.get("status") != "trabalhando":
                return changed
            u = obj.get("usage") if isinstance(obj.get("usage"), dict) else {}
            s["uso"] = {"tokens": u.get("total_tokens"), "ferramentas": u.get("tool_uses"), "ms": u.get("duration_ms")}
            prev = s.get("atividade") or {}
            tool = obj.get("last_tool_name") if isinstance(obj.get("last_tool_name"), str) else prev.get("ferramenta")
            act = {"tipo": "ferramenta", "ferramenta": tool, "texto": _cut(obj.get("description") or "", 120),
                   "alvo": prev.get("alvo") if prev.get("ferramenta") == tool else None, "ts": round(_now(), 3)}
            s["atividade"] = act
            _emit(meta, s["id"], "sub_progresso", id=s["id"], atividade=act)
            return True
        if st in ("task_updated", "task_notification"):
            tid = obj.get("task_id")
            s = (meta.get("subs") or {}).get(tid)
            if not s:
                return changed
            raw = obj.get("status") if st == "task_notification" else (obj.get("patch") or {}).get("status")
            novo = _sub_status(raw)
            if st == "task_notification" and isinstance(obj.get("summary"), str):
                s["resumo"] = _cut(obj["summary"], 600)
                u = obj.get("usage") if isinstance(obj.get("usage"), dict) else None
                if u:
                    s["uso"] = {"tokens": u.get("total_tokens"), "ferramentas": u.get("tool_uses"), "ms": u.get("duration_ms")}
            if novo and s.get("status") == "trabalhando":
                s["status"] = novo
                end = (obj.get("patch") or {}).get("end_time")
                fim = end / 1000.0 if isinstance(end, (int, float)) and not isinstance(end, bool) else _now()
                if not (s.get("inicio") or 0) <= fim <= _now() + 5:
                    fim = _now()
                s["fim"] = round(fim, 3)
                s["atividade"] = {"tipo": "saindo", "ferramenta": None, "alvo": None,
                                  "texto": "terminei!" if novo == "concluido" else "saindo…", "ts": round(_now(), 3)}
                changed = True
            if s.get("status") != "trabalhando" and not s.get("saiu") and (st == "task_notification" or s.get("resumo")):
                s["saiu"] = True
                _emit(meta, tid, "sub_saiu", id=tid, status=s["status"], resumo=s.get("resumo"))
                changed = True
            return changed
        return changed

    if t == "assistant":
        msg = obj.get("message") or {}
        content = msg.get("content")
        if not isinstance(content, list):
            return changed
        if quem == fid:
            rt["awaiting"] = False
        for b in content:
            if not isinstance(b, dict):
                continue
            bt = b.get("type")
            if bt == "text" and (b.get("text") or "").strip():
                txt = b["text"].strip()
                _emit(meta, quem, "fala", texto=_cut(txt, 1500))
                _set_act(meta, quem, {"tipo": "fala", "ferramenta": None, "alvo": None, "texto": _cut(" ".join(txt.split()), 300)})
                changed = True
            elif bt in ("thinking", "redacted_thinking"):
                cur = meta.get("atividade") if quem == fid else ((meta.get("subs") or {}).get(quem) or {}).get("atividade")
                if not cur or cur.get("tipo") != "fala":
                    _set_act(meta, quem, {"tipo": "pensando", "ferramenta": None, "alvo": None, "texto": "pensando…"})
                    changed = True
            elif bt == "tool_use":
                name = b.get("name") if isinstance(b.get("name"), str) else "?"
                tu = b.get("id") if isinstance(b.get("id"), str) else None
                inp = b.get("input") if isinstance(b.get("input"), dict) else {}
                if tu:
                    rt["tu_owner"][tu] = quem
                    rt["tools"][tu] = (quem, name)
                if name in AGENT_TOOLS:
                    desc = _clean_text(inp.get("description") or "subagente", 80)
                    if tu:
                        rt["pend"][tu] = {"descricao": desc, "prompt": _cut(inp.get("prompt") or "", 600),
                                          "tipo": inp.get("subagent_type") if isinstance(inp.get("subagent_type"), str) else None}
                    _set_act(meta, quem, {"tipo": "ferramenta", "ferramenta": "Agent", "alvo": desc, "texto": f"delegando: {desc}"})
                else:
                    alvo = _target(inp, cwd)
                    _emit(meta, quem, "ferramenta", ferramenta=_cut(name, 60), alvo=alvo, id=tu)
                    _set_act(meta, quem, {"tipo": "ferramenta", "ferramenta": _cut(name, 60), "alvo": alvo, "texto": None})
                changed = True
        return changed

    if t == "user":
        msg = obj.get("message") or {}
        content = msg.get("content")
        if not isinstance(content, list):
            return changed
        for b in content:
            if not isinstance(b, dict) or b.get("type") != "tool_result":
                continue
            tu = b.get("tool_use_id")
            owner, name = rt["tools"].get(tu, (quem, None))
            if name in AGENT_TOOLS:
                if b.get("is_error") and tu not in rt["sub_by_tu"]:
                    pend = rt["pend"].pop(tu, None) or {}
                    txt = _result_text(b.get("content"), 200)
                    motivo = "limite de simultâneos" if "Concurrent subagent limit" in txt else (
                        "limite de subagentes da sessão" if "limit" in txt.lower() else _cut(txt, 120))
                    _emit(meta, owner, "sub_recusado", descricao=pend.get("descricao") or "subagente", motivo=motivo)
                    changed = True
                continue
            _emit(meta, owner, "ferramenta_ok", id=tu, erro=bool(b.get("is_error")), resumo=_result_text(b.get("content")))
            changed = True
        return changed

    if t == "result":
        idx = obj.get("result_index")
        if not isinstance(idx, int):
            idx = rt["best_idx"] + 1
        res = obj.get("result")
        pd = obj.get("permission_denials")
        for dn in pd if isinstance(pd, list) else []:
            if isinstance(dn, dict):
                name = str(dn.get("tool_name") or "?")[:60]
                if name not in rt["denied"] and name != "ExitPlanMode":
                    rt["denied"].append(name)
        cost = obj.get("total_cost_usd")
        mu = obj.get("modelUsage")
        if isinstance(mu, dict):
            for k in mu:
                if isinstance(k, str) and k not in (meta.get("modelos_reais") or []):
                    meta.setdefault("modelos_reais", []).append(k[:60])
        if idx >= rt["best_idx"]:
            rt["best_idx"] = idx
            ss = obj.get("subagent_stats") if isinstance(obj.get("subagent_stats"), dict) else {}
            rt["best"] = {"texto": _cut(res, 20000) if isinstance(res, str) else "", "subtype": obj.get("subtype"),
                          "is_error": bool(obj.get("is_error")), "num_turns": obj.get("num_turns"),
                          "duration_ms": obj.get("duration_ms"),
                          "stats": {"spawned": ss.get("spawned"), "completed": ss.get("completed"),
                                    "failed": ss.get("failed"), "refused": ss.get("refused")}}
            if isinstance(cost, (int, float)) and not isinstance(cost, bool):
                rt["last_cost"] = float(cost)
                turn = meta["turns"][-1]
                meta["custo_total"] = round(float(cost), 6)
                meta["custo_turno"] = round(max(0.0, float(cost) - (turn.get("custo_antes") or 0.0)), 6)
                turn["custo_turno"] = meta["custo_turno"]
        _emit(meta, fid, "resultado_parcial", result_index=idx, texto=_cut(res if isinstance(res, str) else "", 300))
        rt["awaiting"] = True
        return True
    return changed


def _refresh_status(meta, rt):
    if not _running(meta):
        return
    n = sum(1 for s in (meta.get("subs") or {}).values() if s.get("status") == "trabalhando")
    novo = "esperando_equipe" if (rt.get("awaiting") and n) else "trabalhando"
    meta["status"] = novo
    if novo == "esperando_equipe":
        txt = f"esperando a equipe ({n})"
        act = meta.get("atividade") or {}
        if act.get("tipo") != "esperando" or act.get("texto") != txt:
            meta["atividade"] = {"tipo": "esperando", "ferramenta": None, "alvo": None, "texto": txt, "ts": round(_now(), 3)}


def _scan_read(path, pos):
    """Lê até 8 lotes do out.ndjson a partir de pos (SEM lock nenhum). → [(items, novo_pos)] ou [("reset", None)]."""
    batches = []
    for _ in range(8):
        try:
            items, npos, reset = scan_lines(path, pos)
        except OSError:
            break
        if reset:
            batches.append(("reset", None))
            break
        if npos == pos:
            break
        batches.append((items, npos))
        pos = npos
        if not items:
            break
    return batches


def _scan_apply(fid, meta, rt, batches):
    """Dobra os lotes lidos. SOB o lock. True se algo público mudou."""
    changed = False
    for items, pos in batches:
        if items == "reset":
            rt["pos"] = meta["turns"][-1].get("offset", 0)
            break
        for lpos, obj in items:
            rt["silent"] = lpos < rt.get("silent_until", 0)
            try:
                changed = _fold(meta, rt, obj) or changed
            except Exception as e:  # noqa: BLE001 — um evento estranho não derruba o funcionário
                core.log(f"[rh] fold {fid}: {e!r}")
        rt["silent"] = False
        rt["pos"] = pos
        meta["scan_pos"] = max(meta.get("scan_pos") or 0, pos)
    _refresh_status(meta, rt)
    return changed


def _out_path(meta):
    return os.path.join(_fdir(meta), "out.ndjson")


def _scan(fid):
    """Lê o out.ndjson a partir de rt.pos e dobra, tudo SOB o lock (fim de turno e boot). O scanner periódico lê fora
    do lock (ver _scanner). True se algo público mudou."""
    meta, rt = FUNCS.get(fid), RT.get(fid)
    if not meta or rt is None or not meta.get("turns"):
        return False
    return _scan_apply(fid, meta, rt, _scan_read(_out_path(meta), rt["pos"]))


def _finish(fid, code):
    fila = None
    with _lock:
        meta = FUNCS.get(fid)
        if not meta or not _running(meta):
            return
        rt = RT.get(fid) or _new_rt(0)
        try:
            _scan(fid)
        except Exception as e:  # noqa: BLE001
            core.log(f"[rh] scan final {fid}: {e!r}")
        turn = meta["turns"][-1]
        turn["fim"], turn["exit"] = _now(), code
        best = rt.get("best")
        erro = None
        if rt.get("cancel"):
            status = "dispensado"
            erro = rt.get("reason") if rt.get("reason") and rt.get("reason") != "dispensado por você" else None
        elif rt.get("orphan") and (not best or any(x.get("status") == "trabalhando" for x in (meta.get("subs") or {}).values())):
            status = "erro"
            erro = "o servidor reiniciou e o turno foi interrompido — mande uma mensagem para continuar"
        elif best and best.get("is_error"):
            status = "erro"
            erro = ERR_TEXT.get(best.get("subtype"), best.get("subtype") or "erro")
            if best.get("subtype") == "error_max_budget_usd":
                erro += f" (US$ {meta.get('budget') or _budget()})"
        elif rt.get("denied"):
            status = "bloqueado"
            erro = "precisou de permissão para " + ", ".join(rt["denied"][:6]) + f" (modo {meta.get('modo')})"
        elif best:
            status = "ocioso"
        else:
            status = "erro"
            erro = f"saiu sem resultado (código {code})" if code is not None else "saiu sem resultado"
            hint = _err_hint(meta)
            if hint:
                erro += ": " + hint
        meta["status"] = status
        if erro:
            meta["erro"] = erro
        else:
            meta.pop("erro", None)
        turn["status"] = status
        if best:
            meta["resultado"] = best
        meta["fim"] = _now()
        for s in (meta.get("subs") or {}).values():
            if s.get("status") == "trabalhando":
                s["status"], s["fim"] = "interrompido", round(_now(), 3)
                s["atividade"] = {"tipo": "saindo", "ferramenta": None, "alvo": None, "texto": "saindo…", "ts": round(_now(), 3)}
            if not s.get("saiu"):
                s["saiu"] = True
                _emit(meta, s["id"], "sub_saiu", id=s["id"], status=s["status"], resumo=s.get("resumo"))
        if status == "dispensado":
            _emit(meta, fid, "dispensado", motivo=rt.get("reason") or "dispensado")
            meta["atividade"] = {"tipo": "saindo", "ferramenta": None, "alvo": None, "texto": "indo embora…", "ts": round(_now(), 3)}
        else:
            if status == "erro" and erro:
                _emit(meta, fid, "erro", texto=erro)
            meta["atividade"] = {"tipo": "parado", "ferramenta": None, "alvo": None,
                                 "texto": {"ocioso": "pronto", "bloqueado": "bloqueado", "erro": "com problema"}.get(status, status),
                                 "ts": round(_now(), 3)}
        _emit(meta, fid, "turno_fim", status=status, custo_turno=meta.get("custo_turno") or 0,
              custo_total=meta.get("custo_total") or 0, texto=_cut((best or {}).get("texto") or erro or "", 1500),
              subtype=(best or {}).get("subtype"))
        rt["proc"] = None
        pid, ps, cancelled = turn.get("pid"), turn.get("procStart"), bool(rt.get("cancel"))
        if status == "ocioso" and meta.get("fila"):
            fila = meta.pop("fila")
        _save(meta)
        office = meta["office"]
    _bump(office)
    _feed_n(fid).bump()
    _reap_group(fid, pid, ps, cancelled)
    if fila:
        try:
            _continue(fid, fila, from_queue=True)
        except core.HttpError as e:
            with _lock:
                m = FUNCS.get(fid)
                if m:
                    _emit(m, fid, "erro", texto=f"mensagem da fila não foi enviada: {e.msg}")
                    _save(m)
            _bump(office)


def _err_hint(meta):
    try:
        with open(os.path.join(_fdir(meta), "err.log"), "rb") as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - 2048))
            lines = [ln.strip() for ln in f.read().decode("utf-8", "replace").splitlines() if ln.strip()]
        return lines[-1][:200] if lines else None
    except OSError:
        return None


def _matar_sobras():
    return os.environ.get("ESC_MATAR_SOBRAS", "1") not in ("0", "false", "no")


def _reap_group(fid, pid, ps, cancelled):
    """O claude saiu mas algo do grupo (ex.: `npm run dev &`, watch, sleep lançados pelo Bash) pode ter ficado — fora
    do ESC_MAX_FUNC e sem prazo. Dispensado → SIGKILL no grupo. Fim normal → SIGTERM e, 5 s depois, SIGKILL em quem
    sobrou (ESC_MATAR_SOBRAS=0 só registra no log, para quem QUER deixar um servidor de dev no ar)."""
    if not pid or ps is None or pid_start(pid) == ps:
        return
    left = group_members(pid, since=ps)
    if not left:
        return
    if cancelled:
        core.log(f"[rh] {fid}: dispensado, {len(left)} processo(s) do grupo sobreviveram — SIGKILL")
        try:
            os.killpg(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    elif not _matar_sobras():
        core.log(f"[rh] {fid}: terminou deixando {len(left)} processo(s) no grupo {pid}: {left[:8]} (ESC_MATAR_SOBRAS=0)")
    else:
        core.log(f"[rh] {fid}: terminou deixando {len(left)} processo(s) no grupo {pid}: {left[:8]} — SIGTERM (SIGKILL em 5 s)")
        try:
            os.killpg(pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            return

        def _hard():
            time.sleep(5)
            if group_members(pid, since=ps):
                try:
                    os.killpg(pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
        threading.Thread(target=_hard, daemon=True, name=f"rh-sobras-{fid}").start()


def ao_encerrar():
    """Chamado pelo server.py ao fechar (Ctrl+C). Sem o servidor, o ESC_WALL não é vigiado (o teto de custo continua
    valendo, é do próprio claude). Padrão: avisa e deixa rodando — no próximo boot o servidor reata e aplica o prazo.
    ESC_ENCERRAR_AO_SAIR=1: dispensa todos (SIGTERM no grupo)."""
    with _lock:
        vivos = [(fid, m.get("nome"), (m.get("turns") or [{}])[-1]) for fid, m in FUNCS.items() if _running(m)]
    vivos = [(fid, nome, t) for fid, nome, t in vivos if _same_proc(t.get("pid"), t.get("procStart"))]
    if not vivos:
        return
    if os.environ.get("ESC_ENCERRAR_AO_SAIR", "") not in ("", "0", "false", "no"):
        for fid, _nome, t in vivos:
            try:
                os.killpg(t["pid"], signal.SIGTERM)
            except (ProcessLookupError, PermissionError, KeyError):
                pass
        print(f"   {len(vivos)} funcionário(s) dispensado(s) ao fechar (ESC_ENCERRAR_AO_SAIR=1).", flush=True)
        return
    nomes = ", ".join(f"{n or fid} (pid {t.get('pid')})" for fid, n, t in vivos[:6])
    print(f"   ⚠️ {len(vivos)} funcionário(s) continuam trabalhando sem o servidor: {nomes}.\n"
          f"      Sem o servidor, o tempo máximo do turno não é vigiado (o teto de gasto continua). Ao reabrir, eles são\n"
          f"      reatados e o prazo volta a valer. Para dispensar todos ao fechar: ESC_ENCERRAR_AO_SAIR=1.", flush=True)


def _same_proc(pid, ps):
    return bool(pid) and ps is not None and pid_start(pid) == ps


def cancel(fid, reason=None):
    """SIGTERM no grupo do processo; SIGKILL em 5 s (cópia do cancel_job do Arquipélago). Os subagentes rodam no mesmo
    processo e morrem junto."""
    with _lock:
        meta, rt = FUNCS.get(fid), RT.get(fid)
        if not meta or not _running(meta) or rt is None:
            return False
        rt["cancel"] = True
        if reason:
            rt["reason"] = reason
        t = meta["turns"][-1]
        pid, ps = t.get("pid"), t.get("procStart")
    if not pid:                       # dry-run: o escritor sintético vê a flag e fecha o turno
        return True
    if not _same_proc(pid, ps):
        return True
    try:
        group = os.getpgid(pid) == pid
        if group:
            os.killpg(pid, signal.SIGTERM)
        else:
            os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return True

    def _kill():
        time.sleep(5)
        if group:
            left = [] if _same_proc(pid, ps) else group_members(pid, since=ps)
            if _same_proc(pid, ps) or left:
                try:
                    os.killpg(pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
        elif _same_proc(pid, ps):
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    threading.Thread(target=_kill, daemon=True, name=f"rh-kill-{fid}").start()
    return True


SAVE_EVERY = 1.0        # s: no máximo 1 gravação do meta.json por funcionário por segundo vinda do scanner


def _scanner():
    """Varredura global (0,7 s) dos funcionários rodando: atividade/subagentes aparecem sem esperar o fim.
    O _lock só é segurado para DOBRAR: a leitura do out.ndjson (até 8×512 KB) e a gravação do meta.json (fsync) ficam
    fora dele, senão lista/feed/contratar esperariam o disco (WSL2 + /home = fsync lento)."""
    while True:
        time.sleep(0.7)
        offices, feeds, snaps = set(), [], []
        with _lock:
            work = [(fid, m, RT.get(fid)) for fid, m in FUNCS.items() if _running(m) and RT.get(fid) and m.get("turns")]
            work = [(fid, m, rt, rt["pos"], _out_path(m)) for fid, m, rt in work]
        read = []
        for fid, m, rt, pos0, path in work:
            try:
                read.append((fid, m, rt, pos0, _scan_read(path, pos0)))
            except Exception as e:  # noqa: BLE001
                core.log(f"[rh] leitura {fid}: {e!r}")
        now = time.monotonic()
        with _lock:
            for fid, m, rt, pos0, batches in read:
                # o turno pode ter acabado/recomeçado enquanto líamos (o _finish dobra sozinho): descarta o lote
                if FUNCS.get(fid) is not m or RT.get(fid) is not rt or rt["pos"] != pos0 or not _running(m):
                    continue
                try:
                    if _scan_apply(fid, m, rt, batches):
                        rt["save_pending"] = True
                        offices.add(m["office"])
                    if rt.get("save_pending") and now - rt.get("last_save", 0.0) >= SAVE_EVERY:
                        rt["save_pending"], rt["last_save"] = False, now
                        snaps.append(_snap(m))
                    if rt.get("feed_dirty"):
                        rt["feed_dirty"] = False
                        feeds.append(fid)
                except Exception as e:  # noqa: BLE001
                    core.log(f"[rh] scan {fid}: {e!r}")
        for snap in snaps:
            try:
                _write_snap(snap)
            except OSError as e:
                core.log(f"[rh] não gravei meta de {snap[0]}: {e!r}")
        for o in offices:
            _bump(o)
        for fid in feeds:
            _feed_n(fid).bump()


# ------------------------------------------------------------------ dry-run: stream-json sintético multiagente
def _dry_writer(fid, out_path, prompt, sid):
    """ESC_DRY_RUN: escreve no out.ndjson um stream parecido com o real (2 subagentes em paralelo, vários result,
    custo cumulativo) sem gastar tokens. Nada é escrito na sala."""
    with _lock:
        meta = FUNCS.get(fid)
        if not meta:
            return
        cwd = meta["_cwd"]
        base = float(meta.get("custo_total") or 0.0)
    slow = "#lento" in prompt
    step = 2.6 if slow else 0.45
    tid_a, tid_b = "a" + secrets.token_hex(8), "a" + secrets.token_hex(8)
    tua, tub, tuc = (f"toolu_dry{secrets.token_hex(6)}" for _ in range(3))
    A = lambda content, ptu=None: {"type": "assistant", "session_id": sid, "parent_tool_use_id": ptu,  # noqa: E731
                                   "message": {"role": "assistant", "model": "claude-dry-run", "content": content}}
    U = lambda tu, txt, ptu=None, err=False: {"type": "user", "session_id": sid, "parent_tool_use_id": ptu,  # noqa: E731
                                              "message": {"role": "user", "content": [
                                                  {"type": "tool_result", "tool_use_id": tu, "content": txt, "is_error": err}]}}
    S = lambda st, **kw: {"type": "system", "subtype": st, "session_id": sid, **kw}  # noqa: E731
    init = S("init", cwd=cwd, model="claude-dry-run", permissionMode=meta.get("modo"), tools=["Task", "Read", "Edit"])
    stats = {"spawned": 2, "completed": 0, "failed": 0, "refused": {"depth_limit": 0, "concurrency_limit": 0, "budget": 0}}

    def R(idx, txt, cost, err=None, denials=()):
        return {"type": "result", "subtype": err or "success", "is_error": bool(err), "session_id": sid,
                "total_cost_usd": round(base + cost, 6), "num_turns": 3, "duration_ms": 1500, "result": txt,
                "permission_denials": list(denials), "result_index": idx, "subagent_stats": dict(stats),
                "modelUsage": {"claude-dry-run": {}}}
    tarefa = " ".join(prompt.split())[:60]
    evs = [
        init,
        A([{"type": "thinking", "thinking": ""}]),
        A([{"type": "text", "text": f"Certo! Vou dividir “{tarefa}”: um colega lê o README e outro procura TODOs."}]),
        A([{"type": "tool_use", "id": tua, "name": "Agent", "input": {"description": "Ler o README", "prompt": "Leia o README.md e resuma."}}]),
        S("task_started", task_id=tid_a, tool_use_id=tua, description="Ler o README", subagent_type="general-purpose",
          spawn_depth=1, prompt="Leia o README.md e resuma."),
        U(tua, "Async agent launched successfully."),
        A([{"type": "tool_use", "id": tub, "name": "Agent", "input": {"description": "Procurar TODOs", "prompt": "Procure TODO."}}]),
        S("task_started", task_id=tid_b, tool_use_id=tub, description="Procurar TODOs", subagent_type="general-purpose",
          spawn_depth=1, prompt="Procure TODO."),
        U(tub, "Async agent launched successfully."),
    ]
    if "#limite" in prompt:
        stats["refused"]["concurrency_limit"] = 1
        evs += [A([{"type": "tool_use", "id": tuc, "name": "Agent", "input": {"description": "Revisar testes", "prompt": "x"}}]),
                U(tuc, "Concurrent subagent limit reached. You can run 2 subagents at once. Do not retry.", err=True)]
    evs += [
        A([{"type": "text", "text": "Deleguei as duas partes. Aguardando a equipe."}]),
        R(0, "Deleguei as duas partes. Aguardando a equipe.", 0.011),
        A([{"type": "tool_use", "id": "toolu_dr1", "name": "Read", "input": {"file_path": os.path.join(cwd, "README.md")}}], tua),
        S("task_progress", task_id=tid_a, tool_use_id=tua, description="Reading README.md", last_tool_name="Read",
          usage={"total_tokens": 9000, "tool_uses": 1, "duration_ms": 2100}),
        A([{"type": "tool_use", "id": "toolu_dr2", "name": "Grep", "input": {"pattern": "TODO", "path": cwd}}], tub),
        S("task_progress", task_id=tid_b, tool_use_id=tub, description="Searching for TODO", last_tool_name="Grep",
          usage={"total_tokens": 9100, "tool_uses": 1, "duration_ms": 2300}),
        U("toolu_dr1", "# Projeto (dry-run)", tua),
        U("toolu_dr2", "src/app.py:3: # TODO revisar", tub),
        A([{"type": "tool_use", "id": "toolu_dr3", "name": "Bash", "input": {"command": "wc -l src/*.py"}}], tub),
        S("task_progress", task_id=tid_b, tool_use_id=tub, description="Running wc -l src/*.py", last_tool_name="Bash",
          usage={"total_tokens": 9800, "tool_uses": 2, "duration_ms": 3900}),
        A([{"type": "text", "text": "O README descreve um projeto de exemplo."}], tua),
        S("task_updated", task_id=tid_a, patch={"status": "completed", "end_time": int(_now() * 1000)}),
        S("task_notification", task_id=tid_a, tool_use_id=tua, status="completed",
          summary="O README descreve um projeto de exemplo.", usage={"total_tokens": 9500, "tool_uses": 1, "duration_ms": 4000}),
        init,
        A([{"type": "text", "text": "O primeiro colega terminou. Falta o dos TODOs."}]),
        R(1, "O primeiro colega terminou. Falta o dos TODOs.", 0.019),
        U("toolu_dr3", "  12 src/app.py", tub),
        A([{"type": "text", "text": "Achei 1 TODO em src/app.py (linha 3)."}], tub),
        S("task_updated", task_id=tid_b, patch={"status": "completed", "end_time": int(_now() * 1000)}),
        S("task_notification", task_id=tid_b, tool_use_id=tub, status="completed",
          summary="Achei 1 TODO em src/app.py (linha 3).", usage={"total_tokens": 10100, "tool_uses": 2, "duration_ms": 5200}),
        init,
        A([{"type": "tool_use", "id": "toolu_dr4", "name": "Edit", "input": {"file_path": os.path.join(cwd, "NOTAS.md")}}]),
        U("toolu_dr4", "ok (dry-run: nada foi escrito)"),
    ]
    final = ("Pronto (dry-run, nada foi executado de verdade):\n- README lido pelo colega 1\n- 1 TODO em src/app.py\n"
             "- NOTAS.md seria atualizado")
    denials = [{"tool_name": "Bash", "tool_use_id": "tb", "tool_input": {"command": "npm test"}}] if "#bloqueia" in prompt else []
    stats = dict(stats, completed=2)
    evs += [A([{"type": "text", "text": final}]),
            R(2, final if "#erro" not in prompt else "", 0.031, err="error_max_budget_usd" if "#erro" in prompt else None,
              denials=denials)]
    for ev in evs:
        end = time.monotonic() + step
        while time.monotonic() < end:
            time.sleep(0.1)
            if RT.get(fid, {}).get("cancel"):
                _finish(fid, -15)
                return
        with open(out_path, "ab") as f:
            f.write((json.dumps(ev, ensure_ascii=False) + "\n").encode("utf-8"))
    time.sleep(0.3)
    _finish(fid, 0)


# ------------------------------------------------------------------ boot: relê os registros e reata os vivos
def _load_office(office, od):
    base = os.path.join(od, core.META_DIR, "rh")
    try:
        names = sorted(os.listdir(base))
    except OSError:
        return
    for name in names:
        if not FID_RE.match(name) or name in FUNCS:
            continue
        try:
            with open(os.path.join(base, name, "meta.json"), encoding="utf-8") as f:
                meta = json.load(f)
        except (OSError, ValueError):
            continue
        if not isinstance(meta, dict) or meta.get("id") != name or not isinstance(meta.get("turns"), list):
            continue
        meta["office"] = office
        meta["_od"] = od
        try:
            meta["_cwd"] = core.room_dir(office, meta.get("sala"))
        except core.HttpError:
            meta["_cwd"] = None
        FUNCS[name] = meta
        if not _running(meta) or not meta["turns"]:
            continue
        t = meta["turns"][-1]
        rt = RT[name] = _new_rt(t.get("offset", 0))
        rt["silent_until"] = meta.get("scan_pos") or 0       # EVT até aqui já foram emitidos: refaz o estado calado
        pid, ps = t.get("pid"), t.get("procStart")
        try:
            _scan(name)
        except Exception as e:  # noqa: BLE001
            core.log(f"[rh] boot scan {name}: {e!r}")
        if pid and ps is not None and is_claude_pid(pid, ps):
            threading.Thread(target=_watch_proc, args=(name, pid, ps, t.get("inicio")), daemon=True,
                             name=f"rh-{name}").start()
            core.log(f"[rh] reatado {name} (pid {pid})")
            continue
        # órfão: o processo morreu com o servidor fora do ar (ou era dry-run)
        rt["orphan"] = True
        threading.Thread(target=_finish, args=(name, None), daemon=True).start()


def _boot():
    global _booted
    if _booted:
        return
    _booted = True
    try:
        root = core.root_real()
        offices = [n for n in os.listdir(root) if not n.startswith(".") and os.path.isdir(os.path.join(root, n))]
    except OSError:
        offices = []
    with _lock:
        for o in offices:
            try:
                od = core.office_dir(o)
            except core.HttpError:
                continue
            _load_office(o, od)
            _loaded_offices.add(o)
        fids = list(FUNCS)
    threading.Thread(target=_scanner, daemon=True, name="rh-scanner").start()
    threading.Thread(target=lambda: [_warm_index(f) for f in fids], daemon=True, name="rh-evidx").start()


_loaded_offices = set()


def _ensure_office(office):
    """Escritório criado depois do boot (ou raiz trocada nos testes): carrega os registros dele uma vez."""
    od = core.office_dir(office)
    with _lock:
        if office not in _loaded_offices:
            _loaded_offices.add(office)
            _load_office(office, od)
    return od


# ------------------------------------------------------------------ validação
def _bad(msg, status=400, **extra):
    raise core.HttpError(status, msg, **extra)


def _func(ctx, q, office):
    fid = (getattr(ctx, "params", None) or {}).get("fid") or ""
    if not FID_RE.match(str(fid)):
        _bad("funcionário inválido")
    meta = FUNCS.get(fid)
    if not meta or meta.get("office") != office:
        _bad("funcionário não encontrado", 404)
    return meta


def _office(ctx):
    office = ctx.office_id()
    od = _ensure_office(office)
    return office, od


def _nome(v):
    if v in (None, ""):
        return None
    if not isinstance(v, str):
        _bad("nome inválido")
    n = " ".join(_clean_text(v, 200).split())[:40]
    return n or None


# ------------------------------------------------------------------ rotas
def r_config(ctx, q):
    office = q.get("office")
    if office:
        _ensure_office(office)
    with _lock:
        rodando = _running_count()
    modo = _mode()
    return {"max_func": _max_func(), "rodando": rodando, "budget": _budget(), "budget_sessao": f"{_budget_sessao():.2f}",
            "wall_s": _wall(), "max_turns": _turns(), "max_por_sala": _max_sala(), "modelos": list(MODELS),
            "modelo_padrao": "sonnet", "modo": modo, "modo_texto": MODE_TEXT.get(modo, modo), "web": _web(),
            "fila": _fila(), "subs_par": _sub_env()["CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS"], "dry_run": _dry(),
            "aviso": AVISO if modo == "bypassPermissions" else
            f"Funcionários trabalham sozinhos na pasta da sala (modo: {MODE_TEXT.get(modo, modo)}).",
            "sugestao_nome": _pick_name()}


def sala_alertas(office, sala):
    """Sala vinda de fora (clone/externa) com CLAUDE.md/AGENTS.md/.claude/: o texto do repositório vira instrução do
    funcionário (prompt injection possível). → [str]."""
    rooms = {r["id"]: r for r in core.list_rooms(office)}
    r = rooms.get(sala)
    if not r:
        _bad("sala não existe", 404)
    kind = (r.get("source") or {}).get("kind")
    if kind not in ("clone", "externa"):
        return []
    cwd = core.room_dir(office, sala)
    achados = [n + ("/" if n == ".claude" else "") for n in INSTR_FILES if os.path.lexists(os.path.join(cwd, n))]
    if not achados:
        return []
    origem = "clonada de " + ((r.get("source") or {}).get("host") or "fora") if kind == "clone" else "colocada por fora"
    return [f"Esta sala foi {origem} e tem {', '.join(achados)}: o funcionário vai ler isso como instrução. "
            "Confira o conteúdo antes (ou use um modo com permissão, ESC_MODO=acceptEdits/auto)."]


def r_sala_alerta(ctx, q):
    """GET /api/rh/sala_alerta?office=&sala= → {alertas:[str]} (o modal de contratar mostra ao escolher a sala)."""
    office, _od = _office(ctx)
    sala = q.get("sala")
    if not isinstance(sala, str) or not sala:
        _bad("diga a sala")
    return {"alertas": sala_alertas(office, sala)}


def r_contratar(ctx, q):
    office, od = _office(ctx)
    body = ctx.json()
    if body.get("confirmo") is not True:
        _bad("confirme que entendeu que o funcionário trabalha sem pedir permissão")
    sala = body.get("sala")
    if not isinstance(sala, str) or not sala:
        _bad("diga a sala")
    cwd = core.room_dir(office, sala)            # 400/404; realpath dentro do escritório
    tarefa = body.get("tarefa")
    if not isinstance(tarefa, str) or not tarefa.strip():
        _bad("diga a tarefa")
    if len(tarefa) > TASK_MAX or "\x00" in tarefa:
        _bad(f"tarefa longa demais (máx. {TASK_MAX} caracteres)")
    modelo = body.get("modelo") or "sonnet"
    if modelo not in MODELS:
        _bad("modelo inválido (use haiku, sonnet ou opus)")
    nome = _nome(body.get("nome"))
    rooms = {r["id"]: r for r in core.list_rooms(office)}
    if sala not in rooms:
        _bad("sala não existe", 404)
    omet = core.read_meta(od)
    with _lock:
        if _running_count() >= _max_func():
            _bad(f"já há {_max_func()} funcionários trabalhando — espere um terminar ou dispense alguém", 429)
        na_sala = sum(1 for m in FUNCS.values() if m.get("office") == office and m.get("sala") == sala and _running(m))
        if na_sala >= _max_sala():
            _bad(f"a sala já tem {na_sala} funcionários trabalhando", 409)
        usados = {m.get("nome") for m in FUNCS.values() if m.get("office") == office and m.get("status") != "dispensado"}
        nome = nome or _pick_name(avoid=usados)
        for _ in range(20):
            fid = "f" + time.strftime("%Y%m%d%H%M%S") + secrets.token_hex(2)
            if fid not in FUNCS:
                break
        d = core.meta_dir(od, "rh", fid)
        os.chmod(d, 0o700)
        meta = {"id": fid, "office": office, "office_nome": omet.get("name") or office, "nome": nome, "sala": sala,
                "sala_nome": rooms[sala].get("display") or sala, "tarefa": _clean_text(tarefa, TASK_MAX),
                "modelo": modelo, "modo": _mode(), "budget": _budget(), "status": "contratando", "session_id": None,
                "atividade": None, "custo_total": 0.0, "custo_turno": 0.0, "turns": [], "inicio": _now(), "fim": None,
                "resultado": None, "subs": {}, "modelos_reais": [], "seq": 0, "scan_pos": 0,
                "_od": od, "_cwd": cwd}
        FUNCS[fid] = meta
        EVIDX[fid] = []
        _emit(meta, fid, "contratado", tarefa=_cut(tarefa, 1500), nome=nome, sala=sala, modelo=modelo, modo=meta["modo"])
        try:
            _start_turn(meta, meta["tarefa"])
        except (OSError, ValueError) as e:
            meta["status"], meta["erro"] = "erro", f"não consegui iniciar o claude: {getattr(e, 'strerror', None) or e}"
            meta["fim"] = _now()
            if meta["turns"]:
                meta["turns"][-1]["fim"] = _now()
            _emit(meta, fid, "erro", texto=meta["erro"])
            _save(meta)
        out = _public(meta)
    _bump(office)
    return out, 201


def _continue(fid, texto, from_queue=False):
    with _lock:
        meta = FUNCS.get(fid)
        if not meta:
            _bad("funcionário não encontrado", 404)
        if _running(meta):
            _bad("o funcionário ainda está trabalhando", 409, erro="ocupado")
        if meta.get("status") == "dispensado":
            _bad("esse funcionário foi dispensado — contrate outro (ou arquive este)", 409, erro="dispensado")
        # --resume SÓ da sessão criada por este registro: sid_origem é o --session-id que o próprio _start_turn gerou
        # (o claude -p reusa o id no --resume; --fork-session não é usado). O session_id do stream é só exibição.
        turns = meta.get("turns") or []
        sid = meta.get("sid_origem") or (turns[0].get("session_id") if turns else None)   # registro antigo
        if not sid or not UUID_RE.match(str(sid)) or meta.get("session_id") != sid:
            _bad("funcionário sem sessão conhecida (ou a sessão mudou) — não dá para continuar; contrate outro", 409)
        if (meta.get("custo_total") or 0) >= _budget_sessao():
            _bad(f"o funcionário já gastou US$ {meta.get('custo_total', 0):.2f} (teto da sessão: US$ {_budget_sessao():.2f})", 409,
                 erro="teto_sessao")
        try:
            meta["_cwd"] = core.room_dir(meta["office"], meta["sala"])
        except core.HttpError:
            _bad("a sala desse funcionário não existe mais", 409)
    if sid in live_session_ids():          # fora do lock: lê /proc e sessions/*.json
        _bad("essa sessão está aberta num claude vivo — retomar corromperia a conversa", 409)
    with _lock:
        if _running(meta) or FUNCS.get(fid) is not meta:
            _bad("o funcionário mudou enquanto isso — tente de novo", 409)
        if _running_count() >= _max_func():
            _bad(f"já há {_max_func()} funcionários trabalhando — espere um terminar", 429)
        if not from_queue:
            _emit(meta, "voce", "mensagem", texto=_cut(texto, 1500))
        try:
            _start_turn(meta, texto, resume=sid)
        except (OSError, ValueError) as e:
            meta["status"], meta["erro"] = "erro", f"não consegui iniciar o claude: {getattr(e, 'strerror', None) or e}"
            meta["turns"][-1]["fim"] = _now()
            _save(meta)
        out = _public(meta)
        office = meta["office"]
    _bump(office)
    return out


def r_mensagem(ctx, q):
    office, _od = _office(ctx)
    meta = _func(ctx, q, office)
    texto = ctx.json().get("texto")
    if not isinstance(texto, str) or not texto.strip():
        _bad("escreva a mensagem")
    if len(texto) > MSG_MAX or "\x00" in texto:
        _bad(f"mensagem longa demais (máx. {MSG_MAX})")
    texto = _clean_text(texto, MSG_MAX)
    if _running(meta) and _fila():
        with _lock:
            meta["fila"] = texto
            _emit(meta, "voce", "mensagem", texto=_cut(texto, 1500), fila=True)
            _save(meta)
            out = _public(meta)
        _bump(office)
        return {**out, "enfileirado": True}, 202
    return _continue(meta["id"], texto), 202


def r_dispensar(ctx, q):
    office, _od = _office(ctx)
    meta = _func(ctx, q, office)
    if not _running(meta):
        with _lock:
            if meta.get("status") != "dispensado":       # parado: dispensar = mandar embora (sem processo)
                meta["status"] = "dispensado"
                meta["atividade"] = {"tipo": "saindo", "ferramenta": None, "alvo": None, "texto": "indo embora…", "ts": _now()}
                _emit(meta, meta["id"], "dispensado", motivo="dispensado por você")
                _save(meta)
        _bump(office)
        return {"ok": True, "id": meta["id"]}
    ok = cancel(meta["id"], reason="dispensado por você")
    _bump(office)
    return {"ok": ok, "id": meta["id"]}


def r_arquivar(ctx, q):
    office, od = _office(ctx)
    with _lock:
        meta = _func(ctx, q, office)
        if _running(meta):
            _bad("o funcionário está trabalhando — dispense antes", 409)
        arq = core.meta_dir(od, "rh", ".arquivo")
        dest = os.path.join(arq, meta["id"])
        if os.path.exists(dest):
            dest += "-" + secrets.token_hex(3)
        os.replace(_fdir(meta), dest)
        FUNCS.pop(meta["id"], None)
        RT.pop(meta["id"], None)
        EVIDX.pop(meta["id"], None)
    _bump(office)
    return {"ok": True, "id": meta["id"]}


def _etag(office):
    return f"{core.BOOT_ID}:{_notifier(office).version}"


def _snapshot(office, sala=None):
    with _lock:
        fs = [m for m in FUNCS.values() if m.get("office") == office and (not sala or m.get("sala") == sala)]
        fs.sort(key=lambda m: m.get("inicio") or 0)
        return {"etag": _etag(office), "rodando": _running_count(), "max_func": _max_func(),
                "funcionarios": [_public(m) for m in fs]}


def r_listar(ctx, q):
    office, _od = _office(ctx)
    sala = q.get("sala") or None
    wait = core.clamp_wait(q.get("wait"), 25)
    etag = str(q.get("etag") or "")
    if wait and etag:
        boot, _, ver = etag.rpartition(":")
        n = _notifier(office)
        if boot == core.BOOT_ID and ver == str(n.version):
            with core.longpoll_slot("rh", 8) as ok:
                if not ok:
                    return {**_snapshot(office, sala), "waited": False}
                n.wait(ver, wait, gone=ctx.client_gone)
    # waited=True também quando voltou na hora porque o etag mudou (resposta legítima de long-poll): o
    # api.longPoll do front só descansa (idleGap) quando o servidor diz que NÃO esperou
    return {**_snapshot(office, sala), "waited": bool(wait)}


def r_um(ctx, q):
    office, _od = _office(ctx)
    with _lock:
        return _public(_func(ctx, q, office), full=True)


def r_feed(ctx, q):
    office, _od = _office(ctx)
    meta = _func(ctx, q, office)
    fid = meta["id"]
    try:
        offset = int(q.get("offset", -1))
    except (TypeError, ValueError):
        _bad("offset inválido")
    quem = q.get("quem") or None
    if quem and not (FID_RE.match(quem) or TASK_ID_RE.match(quem) or quem == "voce"):
        _bad("quem inválido")
    wait = core.clamp_wait(q.get("wait"), 25)
    evs, nxt = _read_events(meta, offset, FEED_MAX, quem)
    waited = bool(wait)
    if not evs and wait and offset >= 0 and _running(meta):
        n = _feed_n(fid)
        offset = max(offset, nxt)
        with core.longpoll_slot("rh-feed", 8) as ok:
            if not ok:
                waited = False
            else:
                v0 = n.version
                end = time.monotonic() + wait
                while _running(meta) and not ctx.client_gone():
                    left = end - time.monotonic()
                    if left <= 0:
                        break
                    n.wait(v0, min(2.0, left), gone=ctx.client_gone)
                    if n.version != v0:
                        v0 = n.version
                        evs, nxt = _read_events(meta, offset, FEED_MAX, quem)
                        if evs:
                            break
                        offset = max(offset, nxt)       # com filtro 'quem': pula o que não é dele
                if not evs:
                    evs, nxt = _read_events(meta, offset, FEED_MAX, quem)
    return {"eventos": evs, "offset": nxt, "vivo": _running(meta), "status": meta.get("status"),
            "waited": waited}


def r_visitantes(ctx, q):
    """Sessões INTERATIVAS vivas do Claude cujo cwd está dentro de uma sala do escritório. Só leitura."""
    office, od = _office(ctx)
    with _lock:
        ours = {m.get("session_id") for m in FUNCS.values()} | {t.get("session_id") for m in FUNCS.values()
                                                                for t in m.get("turns") or []}
    rooms = core.list_rooms(office)
    reais = []
    for r in rooms:
        try:
            reais.append((r["id"], r.get("display") or r["id"], os.path.realpath(r["path"])))
        except OSError:
            continue
    out = []
    for s in live_sessions():
        if s.get("sessionId") in ours or s.get("entrypoint") not in ("cli", None):
            continue
        cwd = s.get("cwd")
        if not isinstance(cwd, str):
            continue
        real = os.path.realpath(cwd)
        for rid, disp, rp in reais:
            if real == rp or real.startswith(rp.rstrip("/") + "/"):
                out.append({"id": "v" + hashlib.sha1(str(s.get("sessionId")).encode()).hexdigest()[:12], "sala": rid,
                            "sala_nome": disp, "nome": _cut(s.get("name") or "", 60) or None,
                            "status": _cut(s.get("status") or "", 30) or None,
                            "desde": (s.get("startedAt") / 1000.0) if isinstance(s.get("startedAt"), (int, float)) else None,
                            "subpasta": _cut(os.path.relpath(real, rp), 80) if real != rp else None})
                break
    return {"visitantes": out[:24]}


def enrich_office(office_id, od, data):
    """GET /api/office/{office} ganha "staff": resumo dos funcionários (o front usa a rota própria para o resto)."""
    _ensure_office(office_id)
    with _lock:
        fs = [m for m in FUNCS.values() if m.get("office") == office_id]
        data["staff"] = {"total": len(fs), "rodando": sum(1 for m in fs if _running(m)), "max_func": _max_func(),
                         "modo": _mode()}


ROUTES = {
    ("GET", "/api/rh/config"): r_config,
    ("POST", "/api/rh/contratar"): r_contratar,
    ("GET", "/api/rh/funcionarios"): r_listar,
    ("GET", "/api/rh/funcionarios/{fid}"): r_um,
    ("GET", "/api/rh/funcionarios/{fid}/feed"): r_feed,
    ("POST", "/api/rh/funcionarios/{fid}/mensagem"): r_mensagem,
    ("POST", "/api/rh/funcionarios/{fid}/dispensar"): r_dispensar,
    ("POST", "/api/rh/funcionarios/{fid}/arquivar"): r_arquivar,
    ("GET", "/api/rh/visitantes"): r_visitantes,
    ("GET", "/api/rh/sala_alerta"): r_sala_alerta,
}
OFFICE_ENRICHERS = [enrich_office]
ON_EXIT = [ao_encerrar]

_boot()
