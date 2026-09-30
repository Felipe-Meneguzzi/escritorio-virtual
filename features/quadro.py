"""PACOTE quadro — backend do QUADRO DE ANOTAÇÕES.

Cada nota é um arquivo .md em <escritório>/quadro/. Nada fora dessa pasta é lido ou escrito (a não ser a lixeira
e a ordem das fichas em <escritório>/.escritorio/).

Rotas (todas exigem X-Esc: 1 e o parâmetro office — ver ARCH.md §Quadro):
    GET    /api/quadro?office=                     → {notes:[NOTE_RESUMO], etag, max, note_max}
    GET    /api/quadro/note?office=&name=X.md      → NOTE {name, content, etag, mtime, size}
    POST   /api/quadro {office, title, content?}   → 201 NOTE (nome final; " (2)" se colidir)
    PUT    /api/quadro/note?office=&name= {content, etag}   → NOTE · 409 {error, current} · 404 · 413
    DELETE /api/quadro/note?office=&name=&etag=    → {ok, trash} (move para .escritorio/lixeira/) · 409 {error, current}
    POST   /api/quadro/restore {office, trash}     → 201 NOTE (desfaz o apagar; sufixo se o nome foi reocupado)

NOTE_RESUMO = {name, title, excerpt, lines:[≤6], size, mtime, etag}
etag = "<mtime_ns hex>-<tamanho hex>". Salvar/apagar exigem o etag lido (edição concorrente: outra aba, um
funcionário Claude, um editor externo) — divergiu → 409 com a versão atual.
Arquivos abertos com O_NOFOLLOW; symlink no quadro → 403 e fica fora da listagem. Limites: core.NOTE_MAX (256 KB)
por nota, core.NOTES_MAX (300) notas.
Ordem das fichas no quadro de cortiça: <escritório>/.escritorio/quadro.json {"order": [nomes]} — nota nova vai para o
fim (não embaralha as outras quando alguém edita). Nota criada por fora entra no fim, apagada por fora sai.
Canal do hub esc:quadro:<office> (sondado a cada 1 s: mtime do diretório + maior mtime das notas).
"""
import errno
import hashlib
import json
import os
import re
import stat
import threading
import time

import esc_core as core

NOTE_RE = re.compile(r"^[^/\\\x00-\x1f\x7f]{1,80}\.md$")
TRASH_RE = re.compile(r"^\d{8}-\d{6}(?:-\d+)?-[^/\\\x00-\x1f\x7f]{1,80}\.md$")
TITLE_MAX = 200
HEAD_BYTES = 4096            # quanto de cada nota a listagem lê (título, trecho e linhas do post-it)
ORDER_FILE = "quadro.json"

_locks = {}
_locks_guard = threading.Lock()


def _lock(d: str) -> threading.RLock:
    with _locks_guard:
        return _locks.setdefault(d, threading.RLock())


# ============================================================ caminhos
def quadro_dir(od: str) -> str:
    """<escritório>/quadro (cria se faltar). Symlink no lugar da pasta → 403."""
    d = os.path.join(od, core.QUADRO)
    if os.path.islink(d):
        raise core.HttpError(403, "a pasta do quadro não pode ser um atalho (symlink)")
    os.makedirs(d, exist_ok=True)
    return core.within(od, d)


def check_name(name) -> str:
    if not isinstance(name, str) or not NOTE_RE.match(name) or name.startswith(".") or name.strip() != name:
        raise core.HttpError(400, "nome de nota inválido")
    return name


def note_path(od: str, name: str):
    d = quadro_dir(od)
    p = os.path.join(d, check_name(name))
    if os.path.islink(p):
        raise core.HttpError(403, "symlink no quadro não é aceito")
    return d, p


def etag_of(st) -> str:
    return f"{st.st_mtime_ns:x}-{st.st_size:x}"


def note_name(title: str) -> str:
    """Título → nome do arquivo (.md). Reaproveita core.sanitize_name (acentos e espaços ficam)."""
    t = title.strip()
    if t.lower().endswith(".md"):
        t = t[:-3]
    try:
        base = core.sanitize_name(t)
    except core.HttpError:
        low = t.strip(" .-_").lower()
        if low in core.RESERVED:             # "Quadro" é nome reservado para pasta, mas ótimo para nota
            base = core.sanitize_name(t + " (nota)")
        else:
            raise
    return base[:76].rstrip(" .-_") + ".md"


# ============================================================ leitura
_MD_STRIP = re.compile(r"[*_`~#]|^\s*(?:>\s*)+|\[([^\]]*)\]\([^)]*\)")


def _plain(line: str) -> str:
    """Linha de markdown → texto do post-it (tarefas viram ☐/☑, links viram o texto)."""
    s = line.strip()
    m = re.match(r"^[-*+]\s+\[([ xX])\]\s+(.*)$", s)
    if m:
        return ("☑ " if m.group(1) != " " else "☐ ") + _MD_STRIP.sub(lambda k: k.group(1) or "", m.group(2)).strip()
    s = re.sub(r"^[-*+]\s+", "• ", s)
    s = re.sub(r"^\d{1,4}[.)]\s+", lambda k: k.group(0).strip() + " ", s)
    return _MD_STRIP.sub(lambda k: k.group(1) or "", s).strip()


def _summary(name: str, head: str):
    """(título, trecho, linhas) a partir do começo do arquivo."""
    title = name[:-3]
    lines = head.replace("\r\n", "\n").split("\n")
    body = []
    got_title = False
    in_code = False
    for ln in lines:
        if ln.strip().startswith(("```", "~~~")):
            in_code = not in_code
            continue
        if in_code:
            continue
        m = re.match(r"^#{1,6}\s+(.+?)\s*#*\s*$", ln)
        if m and not got_title and not body:
            title = _plain(m.group(1))[:80] or title
            got_title = True
            continue
        p = _plain(ln)
        if p and not re.fullmatch(r"[-=_*|:\s]+", p):
            body.append(p[:80])
        if len(body) >= 8:
            break
    excerpt = " ".join(body)[:160]
    return title, excerpt, body[:6]


def _open_note(p: str):
    """Abre sem seguir symlink; só arquivo regular."""
    try:
        fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError as e:
        if e.errno == errno.ELOOP:
            raise core.HttpError(403, "symlink no quadro não é aceito") from None
        if e.errno == errno.ENOENT:
            raise core.HttpError(404, "nota não existe (foi apagada?)") from None
        raise
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode):
        os.close(fd)
        raise core.HttpError(403, "não é um arquivo comum")
    return fd, st


def read_note(od: str, name: str) -> dict:
    _d, p = note_path(od, name)
    fd, st = _open_note(p)
    with os.fdopen(fd, "rb") as f:
        if st.st_size > core.NOTE_MAX:
            raise core.HttpError(413, f"nota passa de {core.NOTE_MAX // 1024} KB — abra num editor de texto",
                                 size=st.st_size)
        data = f.read(core.NOTE_MAX + 1)
    return {"name": name, "content": data.decode("utf-8", "replace"), "etag": etag_of(st),
            "mtime": int(st.st_mtime), "size": st.st_size}


def _scan(d: str) -> list:
    """[(nome, stat)] das notas válidas (sem symlink, sem oculta, só .md regular), no máximo NOTES_MAX."""
    out = []
    with os.scandir(d) as it:
        for e in it:
            n = e.name
            if n.startswith(".") or not n.endswith(".md") or not NOTE_RE.match(n) or e.is_symlink():
                continue
            try:
                st = e.stat(follow_symlinks=False)
            except OSError:
                continue
            if not stat.S_ISREG(st.st_mode):
                continue
            out.append((n, st))
    return out


def _order_path(od: str) -> str:
    return os.path.join(od, core.META_DIR, ORDER_FILE)


def _read_order(od: str) -> list:
    try:
        with open(_order_path(od), encoding="utf-8") as f:
            o = json.load(f).get("order")
        return [n for n in o if isinstance(n, str)] if isinstance(o, list) else []
    except (OSError, ValueError, AttributeError):
        return []


def _write_order(od: str, order: list) -> None:
    if not os.path.isdir(os.path.join(od, core.META_DIR)):
        os.makedirs(os.path.join(od, core.META_DIR), exist_ok=True)
    core.atomic_write(_order_path(od), json.dumps({"order": order}, ensure_ascii=False).encode())


def _reconcile_order(od: str, found: list) -> list:
    """Ordem estável das fichas: a gravada, sem as que sumiram, com as novas no fim (por mtime)."""
    names = {n for n, _ in found}
    old = _read_order(od)
    order = [n for n in old if n in names]
    known = set(order)
    for n, _st in sorted(found, key=lambda x: (x[1].st_mtime_ns, x[0].lower())):
        if n not in known:
            order.append(n)
            known.add(n)
    if order != old:
        try:
            _write_order(od, order)
        except OSError as e:
            core.log(f"[quadro] não gravei a ordem: {e!r}")
    return order


def list_notes(od: str) -> dict:
    d = quadro_dir(od)
    with _lock(d):
        found = _scan(d)
        order = _reconcile_order(od, found)
    by = dict(found)
    notes = []
    for n in order[:core.NOTES_MAX]:
        st = by.get(n)
        if st is None:
            continue
        head = ""
        try:
            fd, _st = _open_note(os.path.join(d, n))
            with os.fdopen(fd, "rb") as f:
                head = f.read(HEAD_BYTES).decode("utf-8", "replace")
        except (OSError, core.HttpError):
            pass
        title, excerpt, lines = _summary(n, head)
        notes.append({"name": n, "title": title, "excerpt": excerpt, "lines": lines, "size": st.st_size,
                      "mtime": int(st.st_mtime), "etag": etag_of(st)})
    tag = f"{len(notes)}:" + ",".join(x["etag"] for x in notes)
    return {"notes": notes, "etag": hashlib.sha1(tag.encode()).hexdigest()[:16], "total": len(found),
            "max": core.NOTES_MAX, "note_max": core.NOTE_MAX}


# ============================================================ escrita
def _body(content) -> bytes:
    if not isinstance(content, str):
        raise core.HttpError(400, "conteúdo inválido")
    b = content.replace("\r\n", "\n").encode("utf-8")
    if len(b) > core.NOTE_MAX:
        raise core.HttpError(413, f"a nota passa de {core.NOTE_MAX // 1024} KB", size=len(b), max=core.NOTE_MAX)
    return b


def create_note(od: str, title, content=None) -> dict:
    if not isinstance(title, str) or not title.strip():
        raise core.HttpError(400, "dê um título para a nota")
    if len(title) > TITLE_MAX:
        raise core.HttpError(400, "título longo demais")
    name = note_name(title)
    shown = " ".join(title.split())
    body = _body(content if isinstance(content, str) and content else f"# {shown}\n\n")
    d = quadro_dir(od)
    base = name[:-3]
    with _lock(d):
        found = _scan(d)
        if len(found) >= core.NOTES_MAX:
            raise core.HttpError(409, f"o quadro está cheio ({core.NOTES_MAX} notas) — apague alguma antes")
        taken = {n.lower() for n in os.listdir(d)}      # sem diferenciar maiúsculas (o Explorer do Windows também vê)
        for i in range(1, 100):
            cand = name if i == 1 else f"{base} ({i}).md"
            if cand.lower() in taken:
                continue
            try:
                fd = os.open(os.path.join(d, cand), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
            except FileExistsError:
                continue
            with os.fdopen(fd, "wb") as f:
                f.write(body)
            order = [n for n in _read_order(od) if n != cand]
            order.append(cand)
            try:
                _write_order(od, order)
            except OSError:
                pass
            return read_note(od, cand)
    raise core.HttpError(409, "já existem notas demais com esse nome")


def save_note(od: str, name: str, content, etag) -> dict:
    if not isinstance(etag, str) or not etag:
        raise core.HttpError(400, "falta o etag da versão que você abriu")
    d, p = note_path(od, name)
    body = _body(content)
    with _lock(d):
        try:
            st = os.lstat(p)
        except FileNotFoundError:
            raise core.HttpError(404, "a nota não existe mais (foi apagada?)") from None
        if not stat.S_ISREG(st.st_mode):
            raise core.HttpError(403, "não é um arquivo comum")
        if etag != etag_of(st):
            raise core.HttpError(409, "a nota mudou desde que você abriu", current=_current(od, name))
        core.atomic_write(p, body, mode=stat.S_IMODE(st.st_mode) or 0o644)
        return read_note(od, name)


def _current(od, name):
    try:
        return read_note(od, name)
    except core.HttpError as e:
        return {"name": name, "error": e.msg}


def _trash_dir(od: str) -> str:
    return core.meta_dir(od, "lixeira")


def delete_note(od: str, name: str, etag) -> dict:
    if not isinstance(etag, str) or not etag:
        raise core.HttpError(400, "falta o etag da versão que você abriu")
    d, p = note_path(od, name)
    with _lock(d):
        try:
            st = os.lstat(p)
        except FileNotFoundError:
            raise core.HttpError(404, "a nota já não existe") from None
        if not stat.S_ISREG(st.st_mode):
            raise core.HttpError(403, "não é um arquivo comum")
        if etag != etag_of(st):
            raise core.HttpError(409, "a nota mudou desde que você abriu — confira antes de apagar",
                                 current=_current(od, name))
        trash = _trash_dir(od)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        dest = f"{stamp}-{name}"
        k = 2
        while os.path.lexists(os.path.join(trash, dest)):
            dest = f"{stamp}-{k}-{name}"
            k += 1
        os.rename(p, os.path.join(trash, dest))
        order = [n for n in _read_order(od) if n != name]
        try:
            _write_order(od, order)
        except OSError:
            pass
    return {"ok": True, "trash": dest}


def restore_note(od: str, trash_name) -> dict:
    if not isinstance(trash_name, str) or not TRASH_RE.match(trash_name) or trash_name.startswith("."):
        raise core.HttpError(400, "item da lixeira inválido")
    trash = _trash_dir(od)
    if os.path.islink(os.path.join(trash, trash_name)):
        raise core.HttpError(403, "symlink na lixeira não é aceito")
    src = core.child(trash, trash_name)
    try:
        st = os.lstat(src)
    except FileNotFoundError:
        raise core.HttpError(404, "não está mais na lixeira") from None
    if not stat.S_ISREG(st.st_mode):
        raise core.HttpError(403, "não é um arquivo comum")
    orig = re.sub(r"^\d{8}-\d{6}(?:-\d+)?-", "", trash_name)
    check_name(orig)
    d = quadro_dir(od)
    base = orig[:-3]
    with _lock(d):
        if len(_scan(d)) >= core.NOTES_MAX:
            raise core.HttpError(409, f"o quadro está cheio ({core.NOTES_MAX} notas)")
        taken = {n.lower() for n in os.listdir(d)}
        for i in range(1, 100):
            cand = orig if i == 1 else f"{base} ({i}).md"
            if cand.lower() in taken:
                continue
            dest = os.path.join(d, cand)
            if os.path.lexists(dest):
                continue
            os.rename(src, dest)
            order = [n for n in _read_order(od) if n != cand]
            order.append(cand)
            try:
                _write_order(od, order)
            except OSError:
                pass
            return read_note(od, cand)
    raise core.HttpError(409, "já existem notas demais com esse nome")


# ============================================================ rotas
def api_list(ctx, q):
    return list_notes(ctx.office_dir())


def api_get(ctx, q):
    return read_note(ctx.office_dir(), q.get("name"))


def api_create(ctx, q):
    body = ctx.json()
    return create_note(ctx.office_dir(), body.get("title"), body.get("content")), 201


def api_save(ctx, q):
    body = ctx.json()
    return save_note(ctx.office_dir(), q.get("name") or body.get("name"), body.get("content"), body.get("etag"))


def api_delete(ctx, q):
    return delete_note(ctx.office_dir(), q.get("name"), q.get("etag"))


def api_restore(ctx, q):
    return restore_note(ctx.office_dir(), ctx.json().get("trash")), 201


ROUTES = {
    ("GET", "/api/quadro"): api_list,
    ("POST", "/api/quadro"): api_create,
    ("GET", "/api/quadro/note"): api_get,
    ("PUT", "/api/quadro/note"): api_save,
    ("DELETE", "/api/quadro/note"): api_delete,
    ("POST", "/api/quadro/restore"): api_restore,
}


# ============================================================ canal do hub
def _probe_factory(name: str):
    oid = name[len("esc:quadro:"):]
    try:
        od = core.office_dir(oid)
    except core.HttpError:
        return None

    def probe():
        d = os.path.join(od, core.QUADRO)
        try:
            dst = os.stat(d)
        except OSError:
            return ("sem-quadro",)
        mx, cnt, tot = 0, 0, 0
        try:
            with os.scandir(d) as it:
                for e in it:
                    if e.name.startswith(".") or not e.name.endswith(".md"):
                        continue
                    try:
                        st = e.stat(follow_symlinks=False)
                    except OSError:
                        continue
                    cnt += 1
                    tot += st.st_size
                    if st.st_mtime_ns > mx:
                        mx = st.st_mtime_ns
                    if cnt > core.NOTES_MAX * 2:
                        break
        except OSError:
            return ("erro",)
        return (dst.st_mtime_ns, mx, cnt, tot)

    return probe


core.channel_prefix("esc:quadro:", _probe_factory, interval=1.0)
