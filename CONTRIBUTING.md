# Contributing

Thank you for helping improve Base Agent.

## Development setup

1. Install Node.js 20.19 or newer and pnpm 11.
2. Fork and clone the repository.
3. Run `pnpm install --frozen-lockfile`.
4. Copy `.env.example` to `.env.local` and add only your own development credentials.
5. Run `pnpm dev`.

Never commit credentials, real cloud resource identifiers, customer data, or environment-specific deployment reports.

## Before opening a pull request

Keep each change focused and include tests when behavior changes. Run:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Describe what changed, why it is needed, and any security or deployment impact. Link related issues when available.

Security vulnerabilities must follow the private process in [SECURITY.md](SECURITY.md).

By submitting a contribution, you agree that it may be distributed under the [MIT License](LICENSE).
