"""Features do backend: cada módulo features/*.py é carregado automaticamente no boot.

Um módulo pode definir (tudo opcional):
    ROUTES = {("GET", "/api/x"): handler}      # handler(ctx, query) -> dict | list | (dict, status) | esc_core.Response
             # caminho com parâmetro: ("POST", "/api/x/{id}/acao") → ctx.params["id"] (um segmento, decodificado)
    OFFICE_ENRICHERS = [fn]                     # fn(office_id, office_dir, data: dict) -> None — acrescenta campos no
                                                # GET /api/office/{office} (ex.: "clones", "staff")
    ON_EXIT = [fn]                              # fn() -> None — chamado quando o servidor fecha (Ctrl+C)
Módulo que falha ao importar é pulado (erro no stderr) — os outros continuam.
Módulos com '_' no começo NÃO são features: são bibliotecas compartilhadas (from . import _x).
"""
import importlib
import pkgutil
import sys
import traceback

ON_EXIT_HOOKS = []


def load_all():
    """Importa todos os features/*.py. Devolve (routes, office_enrichers, loaded, failed)."""
    routes, office_enrichers, loaded, failed = {}, [], [], []
    for info in sorted(pkgutil.iter_modules(__path__), key=lambda m: m.name):
        if info.name.startswith("_"):
            continue
        name = f"{__name__}.{info.name}"
        try:
            mod = importlib.import_module(name)
        except Exception:  # noqa: BLE001
            print(f"[esc] feature {info.name} não carregou:\n{traceback.format_exc()}", file=sys.stderr, flush=True)
            failed.append(info.name)
            continue
        for key, fn in (getattr(mod, "ROUTES", None) or {}).items():
            method, path = key
            key = (method.upper(), path)
            if key in routes:
                print(f"[esc] rota {key} de {info.name} ignorada: já registrada", file=sys.stderr, flush=True)
                continue
            routes[key] = fn
        office_enrichers.extend(getattr(mod, "OFFICE_ENRICHERS", None) or [])
        ON_EXIT_HOOKS.extend(getattr(mod, "ON_EXIT", None) or [])
        loaded.append(info.name)
    return routes, office_enrichers, loaded, failed


def run_exit_hooks():
    """Servidor fechando: cada feature avisa/limpa o que precisar (erro de uma não impede as outras)."""
    for fn in ON_EXIT_HOOKS:
        try:
            fn()
        except Exception:  # noqa: BLE001
            print(f"[esc] ON_EXIT falhou:\n{traceback.format_exc()}", file=sys.stderr, flush=True)
