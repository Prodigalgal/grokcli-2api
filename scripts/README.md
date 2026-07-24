# Python registration worker

The Node runtime owns public APIs, SQLite, account lifecycle, task state, and the admin UI.

`registration_service.py` is an optional internal worker for registration, mailbox access, and captcha/browser fallback. It must remain loopback-only and authenticate requests with `GROK2API_REGISTRATION_TOKEN`. Node owns device login, SSO recovery, accounts, tasks, and all durable SQLite state.
