# Security Policy

## Supported versions

PDF Studio is under active development. Security fixes land on the `main` branch
and the latest release.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Instead, report privately via GitHub's
[Report a vulnerability](https://github.com/juanpabloortizo/pdf-studio/security/advisories/new)
(Security → Advisories) so it can be fixed before disclosure.

Include, if you can:

- A description of the issue and its impact.
- Steps to reproduce (a minimal template/request is ideal).
- Affected version or commit.

You'll get an acknowledgement, and we'll work on a fix and coordinated disclosure.

## Hardening notes for operators

PDF Studio renders arbitrary HTML with a headless browser and exposes a public
API, so when you self-host:

- Put the panel behind the provided `Caddyfile` (only `/v1/*`, `/health` and
  `/s/*` are public; the rest is behind basic auth).
- Use a long random `API_KEY` and give each integration its own scoped key.
- Keep `.env` and `data/` out of version control (they already are).
- The renderer blocks requests to internal/metadata targets (anti-SSRF), rate-limits
  `/v1/*`, and caps concurrent renders — see the **Security** section in the README.
