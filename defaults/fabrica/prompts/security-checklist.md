# Security Checklist (Shared — Developer & Reviewer)

## OWASP Top 10 — BLOCKING (auto-REJECT if found in review)

- A01: Broken Access Control (missing auth checks, IDOR)
- A02: Cryptographic Failures (hardcoded secrets, weak hashing)
- A03: Injection (SQL, command, XSS, template injection)
- A04: Insecure Design (missing rate limits on auth endpoints, no CSRF on forms)
- A07: Auth Failures (weak passwords, default secrets)
- A08: Software Integrity (untrusted dependencies, missing SRI)
- A09: Logging Failures (passwords/tokens/PII in logs)

## Stack-Dependent Mandatory Checks

### Web Apps (FastAPI/Flask/Django/Express/Next.js)

- [ ] **Security headers**: Use security header middleware:
  - Node/Express: `helmet`  |  Python/Flask: `flask-talisman`  |  Django: built-in `SecurityMiddleware` + `django-csp`
- [ ] **CSRF protection**: All state-changing forms must include CSRF tokens:
  - Node/Express: `csurf` or `csrf-csrf`  |  Flask: `Flask-WTF`  |  Django: `{% csrf_token %}`
- [ ] **Rate limiting**: Auth endpoints must have rate limits:
  - Node: `express-rate-limit`  |  Flask: `flask-limiter`  |  Django: `django-ratelimit`  |  FastAPI: `slowapi`
- [ ] **No secrets in code**: Never hardcode passwords, tokens, API keys — use environment variables
- [ ] **No sensitive logs**: Never log passwords, tokens, or PII in console/file output
- [ ] **Cookie security**: `secure=True` (MANDATORY for any web app), `httpOnly=True`, `sameSite='strict'` or `'lax'`
- [ ] **Input validation**: Sanitize user input — parameterized queries, escape output
- [ ] **Error handling**: Never expose stack traces or internal details in production responses

### CLI Projects (no HTTP server, no forms)

Web-specific items above (security headers, CSRF, rate limiting, cookie security) do NOT apply to CLI tools. Focus on:

- [ ] No hardcoded secrets
- [ ] No sensitive logs
- [ ] Input validation
- [ ] No shell injection in subprocess calls

**Detection:** If there is no `/health` endpoint, no forms, no auth routes, no HTTP server setup — treat as CLI. Note "N/A — CLI project" for web-specific items.

## Severity Guide

- **CRITICAL (auto-REJECT)**: Hardcoded secrets, SQL injection, missing auth on protected routes, passwords in logs
- **HIGH (REJECT unless justified)**: Missing helmet/talisman, missing CSRF, no rate limits on auth, stack traces in error responses
- **MEDIUM (non-blocking)**: Missing .env.example, weak password policy, no graceful shutdown, suboptimal cookie settings
- **LOW (nit)**: Missing security comments

## PR & Output Security — BLOCKING (auto-REJECT if found in review)

PR descriptions, comments, and commit messages are **public data sinks**.

- **NEVER** include environment variable names or values in PR descriptions, comments, or commit messages
- **NEVER** embed raw output of `env`, `printenv`, `set`, `export`, `declare -x`
- **NEVER** include tokens, API keys, passwords, or credentials — even partially
- **NEVER** include host-system paths outside the repository (`/home/*/`, `~/.openclaw/`)
- QA output embedded in PRs **must** be filtered through the sanitization pipeline in developer.md

**Known token patterns (auto-REJECT):**
`ghp_`, `gho_`, `github_pat_`, `sk-`, `sk-ant-`, `sk-proj-`, `xoxb-`, `xoxp-`, `AIza`, `AKIA`, `glpat-`, `<digits>:<alphanumeric>` (Telegram)
