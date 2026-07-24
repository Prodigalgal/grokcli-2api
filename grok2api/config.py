"""Configuration used only by the optional Python registration worker."""

from __future__ import annotations

import os


WORKERS = 1

XAI_PROXY = (
    os.getenv("GROK2API_XAI_PROXY")
    or os.getenv("GROK2API_PROXY")
    or ""
).strip()
XAI_PROXY_POOL = (
    os.getenv("GROK2API_XAI_PROXY_POOL")
    or os.getenv("GROK2API_PROXY_POOL")
    or XAI_PROXY
).strip()
XAI_PROXY_USERNAME = (
    os.getenv("GROK2API_XAI_PROXY_USERNAME")
    or os.getenv("GROK2API_PROXY_USERNAME")
    or ""
).strip()
XAI_PROXY_PASSWORD = (
    os.getenv("GROK2API_XAI_PROXY_PASSWORD")
    or os.getenv("GROK2API_PROXY_PASSWORD")
    or ""
).strip()
XAI_PROXY_STRATEGY = (
    os.getenv("GROK2API_XAI_PROXY_STRATEGY")
    or os.getenv("GROK2API_PROXY_STRATEGY")
    or "round_robin"
).strip().lower()

MOEMAIL_BASE_URL = os.getenv("GROK2API_MOEMAIL_BASE_URL", "https://moemail.example.com")
MOEMAIL_API_KEY = os.getenv("GROK2API_MOEMAIL_API_KEY", "")
MOEMAIL_DOMAIN = os.getenv("GROK2API_MOEMAIL_DOMAIN", "example.com")
MOEMAIL_EXPIRY_MS = int(os.getenv("GROK2API_MOEMAIL_EXPIRY_MS", "3600000"))

REDIS_URL = (os.getenv("GROK2API_REDIS_URL") or os.getenv("REDIS_URL") or "").strip()
REDIS_KEY_PREFIX = (os.getenv("GROK2API_REDIS_PREFIX") or "g2a-registration").strip()
