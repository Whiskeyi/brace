# Contributing

Thank you for helping improve Brace.

Participation in this project is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

1. Install Node.js 22.12 or newer and pnpm 11. If you use nvm, run `nvm use`.
2. Fork and clone the repository.
3. Run `pnpm install --frozen-lockfile`.
4. Copy `.env.example` to `.env.local` and add only your own development credentials.
5. Run `pnpm desktop:dev` for the local-first desktop client, or `pnpm dev` for the optional web application.

Never commit credentials, real cloud resource identifiers, customer data, or environment-specific deployment reports.

## Before opening a pull request

Open a feature request before starting a large feature, breaking change, or architecture-level change so the scope can be agreed first.

Keep each change focused and include tests when behavior changes. Run:

```bash
pnpm docs:check
pnpm typecheck
pnpm lint
pnpm test:coverage
pnpm build
pnpm desktop:build
```

On macOS, also run `pnpm desktop:dist` when changing desktop packaging, application metadata, icons, signing, or launch behavior.

Describe what changed, why it is needed, and any security or deployment impact. Link related issues when available.
Target pull requests at `main`, and do not include credentials, customer data, local databases, or generated release artifacts.

Security vulnerabilities must follow the private process in [SECURITY.md](SECURITY.md).

By submitting a contribution, you agree that it may be distributed under the [MIT License](LICENSE).
