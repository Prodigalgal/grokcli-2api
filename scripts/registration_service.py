#!/usr/bin/env python3
"""Internal registration and captcha worker for the Node runtime.

Public API traffic must not hit this service. The Node automation worker calls:

  /internal/registration/v1/*   registration machine (mailbox + captcha)

Python owns:
  - registration orchestration (grok2api.upstream.grok_build_adapter)
  - mailbox providers
  - Turnstile solving via local solver / YesCaptcha

Captcha browser execution can run in the sibling turnstile-solver process.
This service only consumes it and never owns durable application state.
"""

from __future__ import annotations

import os
import secrets
import sys
from pathlib import Path
import json
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse

try:
    from grok2api.upstream import grok_build_adapter as reg
except Exception as exc:  # noqa: BLE001
    reg = None  # type: ignore[assignment]
    _IMPORT_ERROR = str(exc)
else:
    _IMPORT_ERROR = None


app = FastAPI(title="grok2api registration internal API", version="1.0.0")
API_PREFIX = "/internal/registration/v1"


def _require_auth(request: Request) -> None:
    expected = (os.environ.get("GROK2API_REGISTRATION_TOKEN") or "").strip()
    if not expected:
        return
    auth = (request.headers.get("authorization") or "").strip()
    if not auth.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="registration token required")
    token = auth[7:].strip()
    if not secrets.compare_digest(token, expected):
        raise HTTPException(status_code=401, detail="invalid registration token")


def _adapter():
    if reg is None:
        raise HTTPException(
            status_code=503,
            detail=f"registration adapter unavailable: {_IMPORT_ERROR or 'import failed'}",
        )
    return reg


@app.get("/health")
def health() -> dict[str, Any]:
    """Sidecar liveness + lightweight captcha/registration readiness."""
    captcha_provider = (
        os.environ.get("GROK2API_CAPTCHA_PROVIDER")
        or os.environ.get("CAPTCHA_PROVIDER")
        or "local"
    ).strip().lower()
    local_solver = (
        os.environ.get("GROK2API_LOCAL_SOLVER_URL")
        or os.environ.get("LOCAL_SOLVER_URL")
        or "http://127.0.0.1:5072"
    ).strip().rstrip("/")
    out: dict[str, Any] = {
        "ok": reg is not None,
        "service": "registration-worker",
        "adapter_error": _IMPORT_ERROR,
        "registration": reg is not None,
        "captcha_provider": captcha_provider,
        "local_solver_url": local_solver if captcha_provider == "local" else None,
        "endpoints": {"registration": API_PREFIX},
    }
    if reg is not None:
        try:
            avail = reg.registration_available()
            if isinstance(avail, dict):
                out["registration_available"] = avail
        except Exception as exc:  # noqa: BLE001
            out["registration_available_error"] = str(exc)[:300]
    return out



def _jsonable(value: Any, *, depth: int = 0) -> Any:
    """Best-effort JSON sanitizer for adapter responses.

    Registration sessions keep process-local objects under `_receiver` etc.
    If any leak into the response, FastAPI/Pydantic raises 500.
    """
    if depth > 8:
        return None
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for k, v in value.items():
            if not isinstance(k, str):
                continue
            if k.startswith("_"):
                continue
            if callable(v):
                continue
            out[k] = _jsonable(v, depth=depth + 1)
        return out
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(v, depth=depth + 1) for v in value]
    # Drop unknown objects (mail receivers, clients, threads, ...).
    try:
        json.dumps(value)
        return value
    except Exception:
        return str(value)


@app.get(f"{API_PREFIX}/availability")
def availability(request: Request) -> dict[str, Any]:
    _require_auth(request)
    adapter = _adapter()
    return adapter.registration_available()


@app.post(f"{API_PREFIX}/mail/domains")
async def list_mail_domains(request: Request) -> dict[str, Any]:
    """List selectable domains for YYDS / GPTMail / CF Temp Email / TempMail.lol / MoeMail."""
    _require_auth(request)
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    try:
        from grok2api.upstream import moemail as mail
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"moemail module unavailable: {exc}") from exc

    prov = mail.normalize_mail_provider(
        body.get("mail_provider") or body.get("provider"),
        base_url=str(body.get("base_url") or body.get("moemail_base_url") or body.get("cfmail_base_url") or ""),
    )
    key = str(
        body.get("api_key")
        or body.get("moemail_api_key")
        or body.get("yyds_api_key")
        or body.get("gptmail_api_key")
        or body.get("cfmail_api_key")
        or body.get("tempmail_api_key")
        or ""
    ).strip()
    base = str(
        body.get("base_url")
        or body.get("moemail_base_url")
        or body.get("cfmail_base_url")
        or ""
    ).strip()
    domains: list[str] = []
    note = ""
    base_out = base
    try:
        if prov == "yyds":
            domains = mail.yyds_list_domains(api_key=key or None, base_url=base or None)
            note = "YYDS GET /v1/domains"
            base_out = mail.normalize_yyds_base_url(base or None)
        elif prov == "gptmail":
            domains = mail.gptmail_list_domains(api_key=key or None, base_url=base or None)
            note = "GPTMail GET /api/domains/public"
            base_out = mail.normalize_gptmail_base_url(base or None)
        elif prov == "cfmail":
            domains = mail.cfmail_list_domains(api_key=key or None, base_url=base or None)
            note = "CF Temp Email GET /open_api/settings"
            base_out = (base or mail.CFMAIL_DEFAULT_BASE_URL).rstrip("/")
        elif prov == "tempmail":
            domains = mail.tempmail_list_domains(api_key=key or None, base_url=base or None)
            note = "TempMail.lol free: random domain (no catalog)"
            base_out = mail.normalize_tempmail_base_url(base or None)
        else:
            # MoeMail has no universal public catalog; return configured domain list.
            domains = mail.parse_domain_list(str(body.get("domain") or body.get("moemail_domain") or ""))
            note = "MoeMail: no public catalog; showing configured domains only"
            base_out = base
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "ok": True,
        "mail_provider": prov,
        "base_url": base_out,
        "domains": domains,
        "count": len(domains),
        "note": note,
    }


@app.post(f"{API_PREFIX}/jobs")
async def start_job(
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> dict[str, Any]:
    _require_auth(request)
    adapter = _adapter()
    try:
        body = await request.json()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"invalid JSON: {exc}") from exc
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="body must be object")
    # Idempotency key is accepted for contract compatibility; adapter currently
    # relies on its own session/batch ids.
    _ = idempotency_key
    # Accept full body keys then resolve active mail credentials into the
    # historical moemail_api_key / moemail_base_url fields the adapter reads.
    kwargs = {
        k: body.get(k)
        for k in (
            "captcha_provider",
            "local_solver_url",
            "yescaptcha_key",
            "proxy",
            "proxy_username",
            "proxy_password",
            "proxy_strategy",
            "moemail_api_key",
            "moemail_base_url",
            "prefix",
            "domain",
            "expiry_ms",
            "mail_provider",
            "count",
            "concurrency",
            "stagger_ms",
            "probe_delay_sec",
            "yyds_api_key",
            "gptmail_api_key",
            "cfmail_api_key",
            "tempmail_api_key",
            "yyds_domain",
            "gptmail_domain",
            "cfmail_domain",
            "tempmail_domain",
            "moemail_domain",
            "cfmail_base_url",
            "api_key",
            "base_url",
        )
        if k in body
    }
    try:
        from grok2api.upstream.moemail import normalize_mail_provider as _nmp

        prov = _nmp(
            kwargs.get("mail_provider"),
            base_url=str(kwargs.get("moemail_base_url") or kwargs.get("base_url") or ""),
        )
    except Exception:
        prov = str(kwargs.get("mail_provider") or "moemail").strip().lower() or "moemail"
    kwargs["mail_provider"] = prov
    # Active domain from provider-specific slot.
    dom = str(kwargs.get("domain") or "").strip()
    if prov == "yyds":
        dom = str(kwargs.get("yyds_domain") or dom).strip()
        key = str(kwargs.get("yyds_api_key") or kwargs.get("api_key") or "").strip()
        # Prefer dedicated slot; only fall back to moemail_api_key if it looks like YYDS.
        if not key:
            mk = str(kwargs.get("moemail_api_key") or "").strip()
            if mk.startswith("AC-"):
                key = mk
        kwargs["moemail_api_key"] = key
        kwargs["moemail_base_url"] = ""  # fixed host
        kwargs["domain"] = dom
        if not key:
            raise HTTPException(
                status_code=400,
                detail="YYDS API Key missing. Save AC-… key in 协议注册配置 (YYDS panel).",
            )
    elif prov == "gptmail":
        dom = str(kwargs.get("gptmail_domain") or dom).strip()
        key = str(kwargs.get("gptmail_api_key") or kwargs.get("api_key") or "").strip()
        # Empty key is OK only if a real sk-… is later provided; reject other shapes.
        if key.startswith("mk_") or key.startswith("AC-"):
            key = ""
        kwargs["moemail_api_key"] = key
        kwargs["moemail_base_url"] = ""
        kwargs["domain"] = dom
        if not key:
            raise HTTPException(
                status_code=400,
                detail="GPTMail API Key missing. Save sk-… from https://mail.chatgpt.org.uk/zh/api/",
            )
    elif prov == "cfmail":
        dom = str(kwargs.get("cfmail_domain") or dom).strip()
        key = str(kwargs.get("cfmail_api_key") or kwargs.get("api_key") or kwargs.get("moemail_api_key") or "").strip()
        base = str(kwargs.get("cfmail_base_url") or kwargs.get("base_url") or kwargs.get("moemail_base_url") or "").strip()
        kwargs["moemail_api_key"] = key
        kwargs["moemail_base_url"] = base
        kwargs["domain"] = dom
        if not key:
            raise HTTPException(
                status_code=400,
                detail="CF Temp Email admin password/key missing.",
            )
        if not base:
            raise HTTPException(
                status_code=400,
                detail="CF Temp Email Base URL missing.",
            )
    elif prov == "tempmail":
        # Free tier: no API key required. Optional Plus/Ultra Bearer key.
        dom = str(kwargs.get("tempmail_domain") or dom).strip()
        key = str(kwargs.get("tempmail_api_key") or kwargs.get("api_key") or "").strip()
        kwargs["moemail_api_key"] = key
        kwargs["moemail_base_url"] = ""
        kwargs["domain"] = dom
    else:
        key = str(kwargs.get("moemail_api_key") or kwargs.get("api_key") or "").strip()
        base = str(kwargs.get("moemail_base_url") or kwargs.get("base_url") or "").strip()
        dom = str(kwargs.get("moemail_domain") or dom).strip()
        # Reject cross-provider pollution (YYDS AC-* / GPTMail sk-* in MoeMail slot).
        if key.startswith("AC-") or key.lower().startswith("sk-"):
            key = ""
        kwargs["moemail_api_key"] = key
        kwargs["moemail_base_url"] = base
        kwargs["domain"] = dom
        if not key:
            raise HTTPException(
                status_code=400,
                detail=(
                    "MoeMail API Key missing or invalid (got YYDS/GPTMail-shaped key). "
                    "Re-save MoeMail Key (mk_…) in 协议注册配置 — switching providers "
                    "must not overwrite the MoeMail slot."
                ),
            )
        if not base:
            raise HTTPException(
                status_code=400,
                detail="MoeMail Base URL missing. Re-save MoeMail Base URL in 协议注册配置.",
            )
    # Drop non-adapter kwargs
    for drop in (
        "yyds_api_key", "gptmail_api_key", "cfmail_api_key", "tempmail_api_key",
        "yyds_domain", "gptmail_domain", "cfmail_domain", "tempmail_domain", "moemail_domain",
        "cfmail_base_url", "api_key", "base_url",
    ):
        kwargs.pop(drop, None)
    result = adapter.start_registration(**kwargs)
    if not isinstance(result, dict):
        raise HTTPException(status_code=500, detail="invalid registration response")
    if result.get("ok") is False:
        raise HTTPException(status_code=400, detail=str(result.get("error") or "registration failed"))
    return _jsonable(result)


@app.get(f"{API_PREFIX}/sessions")
def list_sessions(request: Request) -> dict[str, Any]:
    _require_auth(request)
    adapter = _adapter()
    return _jsonable(adapter.list_registration_sessions())


@app.get(f"{API_PREFIX}/sessions/{{session_id}}")
def get_session(session_id: str, request: Request) -> dict[str, Any]:
    _require_auth(request)
    adapter = _adapter()
    include_auth = (request.query_params.get("include_auth_json") or "").strip() in {
        "1",
        "true",
        "yes",
    }
    sess = adapter.get_registration_session(session_id, include_auth_json=include_auth)
    if not sess:
        raise HTTPException(status_code=404, detail="session not found")
    return _jsonable(sess)


@app.post(f"{API_PREFIX}/sessions/{{session_id}}/stop")
def stop_session(session_id: str, request: Request) -> dict[str, Any]:
    _require_auth(request)
    adapter = _adapter()
    return _jsonable(adapter.stop_registration_session(session_id))


@app.get(f"{API_PREFIX}/batches/{{batch_id}}")
def get_batch(batch_id: str, request: Request) -> dict[str, Any]:
    _require_auth(request)
    adapter = _adapter()
    batch = adapter.get_registration_batch(batch_id)
    if not batch:
        raise HTTPException(status_code=404, detail="batch not found")
    return _jsonable(batch)


@app.post(f"{API_PREFIX}/batches/{{batch_id}}/resume")
async def resume_batch(batch_id: str, request: Request) -> dict[str, Any]:
    _require_auth(request)
    adapter = _adapter()
    force = False
    try:
        body = await request.json()
        if isinstance(body, dict):
            force = bool(body.get("force"))
    except Exception:
        force = False
    return _jsonable(adapter.resume_registration_batch(batch_id, force=force))


@app.post(f"{API_PREFIX}/batches/{{batch_id}}/stop")
def stop_batch(batch_id: str, request: Request) -> dict[str, Any]:
    _require_auth(request)
    adapter = _adapter()
    return _jsonable(adapter.stop_registration_batch(batch_id))


@app.post(f"{API_PREFIX}/reclaim")
async def reclaim(request: Request) -> dict[str, Any]:
    _require_auth(request)
    adapter = _adapter()
    auto_resume = True
    try:
        body = await request.json()
        if isinstance(body, dict) and "auto_resume" in body:
            auto_resume = bool(body.get("auto_resume"))
    except Exception:
        pass
    # Prefer batch reclaim which also reclaims sessions.
    fn = getattr(adapter, "reclaim_orphaned_registration_batches", None)
    if callable(fn):
        # signature may not take auto_resume; call best-effort
        try:
            return _jsonable(fn(auto_resume=auto_resume))  # type: ignore[misc]
        except TypeError:
            return _jsonable(fn())
    fn2 = getattr(adapter, "reclaim_orphaned_registration_sessions", None)
    if callable(fn2):
        return _jsonable(fn2())
    return {"ok": True, "reclaimed": 0}


@app.post(f"{API_PREFIX}/stop")
def stop_all(request: Request) -> dict[str, Any]:
    _require_auth(request)
    adapter = _adapter()
    return _jsonable(adapter.stop_all_active_registrations())


@app.exception_handler(HTTPException)
async def http_error_handler(_: Request, exc: HTTPException) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})


def main() -> None:
    import uvicorn

    host = os.environ.get("GROK2API_REGISTRATION_HOST", "127.0.0.1")
    port = int(os.environ.get("GROK2API_REGISTRATION_PORT", "18070") or 18070)
    uvicorn.run(
        "scripts.registration_service:app",
        host=host,
        port=port,
        log_level=os.environ.get("GROK2API_REGISTRATION_LOG", "info"),
        factory=False,
    )


if __name__ == "__main__":
    # Support both `python scripts/registration_service.py` and module import.
    import uvicorn

    host = os.environ.get("GROK2API_REGISTRATION_HOST", "127.0.0.1")
    port = int(os.environ.get("GROK2API_REGISTRATION_PORT", "18070") or 18070)
    uvicorn.run(app, host=host, port=port, log_level="info")
