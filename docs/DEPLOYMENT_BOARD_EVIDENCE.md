# DOTS-026 local acceptance observation

Observed 2026-11-01 against implementation commit `2ec8092a56f887e94b7bfa88caefdceb3674a753`.

- `pnpm check`: passed; 106 tests, TypeScript, static lint, secret scan and production build.
- `pnpm audit:dependencies`: no known vulnerabilities found.
- `pnpm test:deployment:browser`: passed using Chromium 153.0.8010.0 and Playwright 1.64.1, local HTTPS, synthetic owner/session and isolated PGlite storage.
- Native drag/drop opened unsaved settings; a delayed save displayed optimistic placement and pending status.
- Successful save matched the server after a browser reload.
- An injected stale-write conflict restored the original assignment.
- An injected lost confirmation after commit reloaded the committed move without a duplicate.
- Hide/show retained the assignment; an oversized body returned 413 and an untrusted origin returned 403.
- No page errors; no horizontal page overflow at 1440, 1024, 768, 390 or 320 pixels.

The local screenshots were visually reviewed at desktop and narrow widths, including the settings dialog. The source gateway accepts UTF-8 only, so binary images are not committed. Reproduce them with the documented harness. SHA-256 observations:

| Local output | SHA-256 |
| --- | --- |
| `board-1024.png` | `a6c05431651eab3bfc1b1f85167336f223f5e4f0c9960d7b3df12e03ce36097e` |
| `board-1440.png` | `4f443744ed89ed38040bf8cc2a50327d3619a17a942a548de6f4b9074dea1034` |
| `board-320.png` | `483bd3658d4f217cdd07b87f3a0bbb825a6480af0c02a795eaaeb4c433dfab28` |
| `board-390.png` | `5a0c1acfd53ee7e8b1c11b915a67c750921998a2cc8d1fb1821c921792dcecfb` |
| `board-768.png` | `d3d356beca167658ac50b36fce7909e0f55b62bc7359c6104f7e1908a129c115` |
| `conflicting-drop.png` | `73b0c26711b260fb7adf56fd0d85d9325b1161d9d500968f4dd80087ef5f8a06` |
| `pending-save.png` | `b96900dbb91629f03077d0e3472dfd0c363b7d30dc9350c9a0eff76263ca9461` |
| `unsaved-settings.png` | `d354d1c178df3aa75a67f2bba2b8800e1aa8ba58895ce34ee7032c717e39bba6` |

These observations do not establish a deployed service, real provider availability or worker activity. Runtime session/database configuration is still required. The protected canonical registry was left unchanged after `INPUT_REJECTED: Protected path requires owner authorization`; Boardroom verified PR #33 on the assigned branch.
