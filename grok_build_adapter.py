"""Adapter: grok-build-auth -> grokcli-2api account pool.

Replaces the legacy email_registration.py flow by driving
``grok-build-auth/xconsole_client`` to:

1. register an x.ai account with temp-mail + YesCaptcha
2. extract SSO/session cookies
3. complete Build OAuth (PKCE + consent) using the signup session
4. import the resulting CLIProxyAPI auth record into grokcli-2api's auth.json
"""
from __future__ import annotations

import json
import os
import secrets
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
GBA = ROOT / "grok-build-auth"
if not GBA.is_dir():
    raise RuntimeError("grok-build-auth submodule not found; run: git submodule update --init")
if str(GBA) not in sys.path:
    sys.path.insert(0, str(GBA))

from xconsole_client import (
    XConsoleAuthClient,
    YesCaptchaSolver,
    create_solver,
    xai_oauth_login_protocol,
)
from xconsole_client.oauth_protocol import extract_cookies_from_auth_client
from xconsole_client.xai_oauth import (
    CLIPROXYAPI_GROK_BASE_URL,
    CLIPROXYAPI_GROK_HEADERS,
    build_cliproxyapi_auth_record,
    default_cliproxyapi_auth_dir,
)

import accounts
from config import (
    AUTH_FILE,
    DATA_DIR,
    UPSTREAM_BASE,
    XAI_PROXY,
    XAI_PROXY_PASSWORD,
    XAI_PROXY_USERNAME,
)

YESCAPTCHA_KEY = os.environ.get("GROK2API_YESCAPTCHA_KEY", "").strip()

# --------------------------------------------------------------------------- #
# session state
# --------------------------------------------------------------------------- #
_sessions: dict[str, dict[str, Any]] = {}
_lock = threading.Lock()


def _now() -> float:
    return time.time()


def _clean_old_sessions() -> None:
    cutoff = _now() - 6 * 3600
    for sid in list(_sessions.keys()):
        sess = _sessions.get(sid) or {}
        if float(sess.get("updated_at") or 0) < cutoff:
            _sessions.pop(sid, None)


def _compact_session(sess: dict[str, Any]) -> dict[str, Any]:
    out = dict(sess)
    out.pop("_client", None)
    out.pop("_oauth_client", None)
    if out.get("auth_json"):
        out["auth_json_count"] = len(out["auth_json"])
        out.pop("auth_json", None)
    return out


# --------------------------------------------------------------------------- #
# mail provider: moemail (reuse grokcli-2api config)
# --------------------------------------------------------------------------- #
from email_registration import (
    _extract_codes_and_links,
    _headers as _moemail_headers,
    _moemail_create_mailbox,
    _moemail_fetch_messages,
    _normalize_proxy_config,
)  # type: ignore


class _MoeMailReceiver:
    def __init__(self, email: str, email_id: str, api_key: str | None, base_url: str | None):
        self.email = email
        self.email_id = email_id
        self.api_key = api_key
        self.base_url = base_url or "https://moemail.521884.xyz"

    def wait_for_code(self, timeout: float = 120) -> str:
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                messages = _moemail_fetch_messages(
                    self.email_id,
                    api_key=self.api_key,
                    base_url=self.base_url,
                    include_details=True,
                )
                for item in messages:
                    extracted = item.get("extracted") or {}
                    codes = extracted.get("codes") or []
                    for code in codes:
                        clean = str(code).replace("-", "").strip().upper()
                        if len(clean) == 6:
                            return clean
                    # fallback: scan raw text for AAA-BBB pattern
                    text = "\n".join(
                        str(item.get(k) or "")
                        for k in ("subject", "content", "html", "from_address", "from")
                    )
                    match = __import__("re").search(r"\b([A-Z0-9]{3})-([A-Z0-9]{3})\b", text)
                    if match:
                        return "".join(match.groups())
            except Exception:
                pass
            time.sleep(5)
        raise RuntimeError("timeout waiting for xAI email verification code")


def _make_email_receiver(
    *,
    api_key: str | None = None,
    base_url: str | None = None,
    prefix: str | None = None,
    domain: str | None = None,
    expiry_ms: int | None = None,
) -> tuple[str, _MoeMailReceiver]:
    from config import MOEMAIL_API_KEY, MOEMAIL_BASE_URL, MOEMAIL_DOMAIN, MOEMAIL_EXPIRY_MS

    key = (api_key or MOEMAIL_API_KEY or "").strip()
    if not key:
        raise ValueError("MoeMail API key missing. Set GROK2API_MOEMAIL_API_KEY or pass api_key.")
    base = (base_url or MOEMAIL_BASE_URL).rstrip("/")
    dom = (domain or MOEMAIL_DOMAIN).strip(".")
    pre = (prefix or f"grok-{secrets.token_hex(4)}").lower()

    mailbox = _moemail_create_mailbox(
        name=pre,
        domain=dom,
        expiry_ms=expiry_ms,
        api_key=key,
        base_url=base,
    )
    email_id = mailbox["id"]
    address = mailbox["email"]
    return address, _MoeMailReceiver(address, email_id, api_key=key, base_url=base)


# --------------------------------------------------------------------------- #
# proxy helpers
# --------------------------------------------------------------------------- #
def _proxy_url() -> str:
    cfg = _normalize_proxy_config(XAI_PROXY or None)
    return cfg["proxy"] if cfg else ""


# --------------------------------------------------------------------------- #
# registration flow
# --------------------------------------------------------------------------- #
def start_registration(
    *,
    yescaptcha_key: str | None = None,
    proxy: str | None = None,
    moemail_api_key: str | None = None,
    moemail_base_url: str | None = None,
    prefix: str | None = None,
    domain: str | None = None,
    expiry_ms: int | None = None,
) -> dict[str, Any]:
    """Start one registration session and return its public state."""
    _clean_old_sessions()

    key = (yescaptcha_key or YESCAPTCHA_KEY or "").strip()
    if not key:
        return {"ok": False, "error": "YESCAPTCHA_KEY is required"}

    sid = f"gba_{uuid.uuid4().hex[:16]}"
    email, receiver = _make_email_receiver(
        api_key=moemail_api_key,
        base_url=moemail_base_url,
        prefix=prefix,
        domain=domain,
        expiry_ms=expiry_ms,
    )
    password = f"Pw{os.urandom(8).hex()}!a#A"

    sess = {
        "id": sid,
        "status": "started",
        "created_at": _now(),
        "updated_at": _now(),
        "email": email,
        "password": password,
        "message": f"started; email={email}",
        "sso": None,
        "oauth": None,
        "auth_json": None,
        "error": None,
        "yescaptcha_key": key,
        "proxy": proxy or _proxy_url(),
    }
    _sessions[sid] = sess

    threading.Thread(
        target=_run_registration,
        args=(sid, key, proxy or _proxy_url(), receiver),
        daemon=True,
    ).start()

    return {"ok": True, **_compact_session(sess)}


def _run_registration(
    sid: str,
    yescaptcha_key: str,
    proxy: str,
    receiver: _MoeMailReceiver,
) -> None:
    sess = _sessions.get(sid)
    if not sess:
        return

    def update(status: str, message: str, **kwargs: Any) -> None:
        sess["status"] = status
        sess["message"] = message
        sess["updated_at"] = _now()
        sess.update(kwargs)

    email = sess["email"]
    password = sess["password"]

    try:
        update("registering", "visiting signup page")
        client = XConsoleAuthClient(
            debug=True,
            proxy=proxy or "",
            signup_url="https://accounts.x.ai/sign-up?redirect=grok-com",
        )
        client.visit_home()
        client.load_signup_page()

        update("registering", "sending email validation code")
        client.create_email_validation_code(email)

        update("waiting_email", "waiting for xAI verification code")
        code = receiver.wait_for_code(timeout=120)
        update("registering", f"code received: {code}")

        client.verify_email_validation_code(email, code)
        client.validate_password(email, password)

        update("solving_turnstile", "solving Turnstile")
        solver = YesCaptchaSolver(yescaptcha_key)
        from xconsole_client import config as C
        turnstile = solver.solve_turnstile(
            website_url=C.SIGNUP_URL,
            website_key=C.TURNSTILE_SITEKEY,
            premium=True,
        )

        update("creating_account", "creating xAI account")
        res = client.create_account(
            email=email,
            given_name="User",
            family_name="Grok",
            password=password,
            email_validation_code=code,
            turnstile_token=turnstile,
            castle_request_token="",
            conversion_id=str(uuid.uuid4()),
        )
        if not getattr(res, "ok", False):
            raise RuntimeError(f"create_account failed: HTTP {getattr(res, 'http_status', '?')}")

        update("fetching_sso", "extracting SSO session")
        print(f"[grok-build-auth] create_account set-cookies: {getattr(res, 'set_cookies', [])}")
        print(f"[grok-build-auth] create_account rsc_body preview: {getattr(res, 'rsc_body', '')[:500]}")
        sso = client.fetch_sso_token(email=email, password=password, save=True, retries=3)
        print(f"[grok-build-auth] fetch_sso_token result: {sso[:60] if sso else None}")
        if not sso:
            raise RuntimeError("SSO extraction failed")
        sess["sso"] = sso

        update("oauth", "completing Build OAuth")
        session_cookies = extract_cookies_from_auth_client(client)
        if sso:
            session_cookies = dict(session_cookies or {})
            session_cookies.setdefault("sso", sso)

        oauth = xai_oauth_login_protocol(
            email,
            password,
            yescaptcha_key=yescaptcha_key,
            proxy=proxy or "",
            debug=False,
            turnstile_premium=True,
            cliproxyapi_auth_dir=None,
            cliproxyapi_base_url=UPSTREAM_BASE.rstrip("/"),
            cliproxyapi_disabled=True,
            output_dir=None,
            redirect_port=56121,
            session_cookies=session_cookies,
            auth_client=client,
        )
        sess["oauth"] = {
            "access_token": oauth.access_token[:20] + "..." if oauth.access_token else None,
            "refresh_token": bool(oauth.refresh_token),
            "email": oauth.email,
        }

        update("importing", "importing token into auth.json")
        record = build_cliproxyapi_auth_record(
            oauth.token,
            userinfo=oauth.userinfo,
            redirect_uri=oauth.redirect_uri,
            disabled=False,
            base_url=UPSTREAM_BASE.rstrip("/"),
            headers=dict(CLIPROXYAPI_GROK_HEADERS),
        )
        # Normalize to grokcli-2api entry shape.
        import_result = accounts.import_auth_payload(
            {
                "key": record["access_token"],
                "auth_mode": "build_oauth",
                "email": record.get("email"),
                "refresh_token": record.get("refresh_token"),
                "expires_at": record.get("expired"),
                "oidc_issuer": "https://auth.x.ai",
                "oidc_client_id": record.get("client_id", ""),
                "first_name": record.get("first_name"),
                "last_name": record.get("last_name"),
                "principal_type": record.get("principal_type"),
            },
            merge=True,
        )
        sess["auth_json"] = import_result
        if not import_result.get("ok"):
            raise RuntimeError(f"import failed: {import_result.get('error')}")

        update("imported", f"imported {len(import_result.get('imported', []))} account(s)")
    except Exception as exc:  # noqa: BLE001
        update("error", f"failed: {exc}", error=str(exc))
    finally:
        try:
            client.close()
        except Exception:
            pass


def list_registration_sessions() -> dict[str, Any]:
    _clean_old_sessions()
    return {"sessions": [_compact_session(s) for s in _sessions.values()]}


def get_registration_session(sid: str, *, include_auth_json: bool = False) -> dict[str, Any] | None:
    sess = _sessions.get(sid)
    if not sess:
        return None
    out = dict(sess)
    out.pop("_client", None)
    out.pop("_oauth_client", None)
    if not include_auth_json:
        out.pop("auth_json", None)
    return out


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def main() -> int:
    print("grok-build-auth adapter for grokcli-2api")
    result = start_registration()
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if not result.get("ok"):
        return 1

    sid = result["id"]
    deadline = time.time() + 600
    while time.time() < deadline:
        sess = get_registration_session(sid, include_auth_json=True)
        if not sess:
            print("session disappeared", file=sys.stderr)
            return 1
        status = sess.get("status")
        print(f"[{time.strftime('%H:%M:%S')}] {status}: {sess.get('message')}")
        if status in ("imported", "error"):
            print(json.dumps(sess, ensure_ascii=False, indent=2))
            return 0 if status == "imported" else 1
        time.sleep(5)

    print("timeout", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
