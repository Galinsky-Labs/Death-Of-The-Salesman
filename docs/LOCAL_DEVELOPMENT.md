# Local development

The foundation requires Node.js 22 or newer and Corepack/pnpm. It starts without credentials, external
accounts, a database, model calls, outbound messages, or paid resources.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm dev
```

Run the complete source-quality gate with `pnpm check`. `pnpm audit:dependencies` performs the
network-backed high-severity dependency review used by CI. The test-failure contract is invoked
separately by CI; the intentionally failing fixture is excluded from the ordinary test glob.

The web console is available at `http://localhost:3000`. Its health route is `/api/health`.
The standalone API can be built with the root build and started with `pnpm start:api`; it binds
only to `127.0.0.1:3001` by default and exposes `/health`. `pnpm start:worker` confirms the
separate worker boundary while remaining disabled. Runtime configuration is defined in `packages/config`; see `docs/CONFIGURATION.md`. Later plan units own database,
authentication, domain contracts, queues, and production deployment.

The owner-backed `/deployment` board has separate storage, session and public-origin requirements.
See [Deployment board](DEPLOYMENT_BOARD.md) for configuration and isolated browser acceptance.

