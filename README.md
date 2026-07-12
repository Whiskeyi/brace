# Base Agent on Alibaba Cloud RDS AI

A production-minded, provider-neutral agent foundation built for Alibaba Cloud RDS AI Application Platform (RDS Supabase). It combines a Next.js chat application with a bounded tool-calling runtime, Supabase Auth/RLS, durable conversation state, RAG, long-term memory, audit records, and optional web search.

[MIT licensed](LICENSE). This is an independent community project and is not affiliated with or endorsed by Alibaba Cloud or Supabase.

The system is intentionally split into two parts:

- **RDS Supabase capability layer:** Auth, PostgreSQL, RLS, Storage/OSS, optional RAG Agent, and optional mem0.
- **Independent Agent runtime:** model calls, streaming, tool routing, validation, cancellation, timeouts, idempotency, budgets, and observability.

See [architecture.md](docs/architecture.md) for the trust boundaries and production topology.

## Included capabilities

| Area | Implementation |
| --- | --- |
| Conversation | Multi-turn history, conversation list, durable messages, responsive UI |
| Model | Any OpenAI-compatible Chat Completions endpoint; Qwen/DashScope example included |
| Streaming | Typed SSE events for lifecycle, delta, tool call/result, usage, completion, and errors |
| Agent loop | Fragmented tool-call assembly, parallel tools, maximum rounds, AbortSignal, per-tool timeout, isolated failures |
| Base tools | Current time and a custom numeric parser that never evaluates JavaScript |
| Web | Optional Tavily or Brave search, enabled only when a server-side key exists |
| Knowledge | Optional Alibaba Cloud RAG Agent context-only retrieval; dataset IDs are a server allowlist |
| Memory | User-scoped application memory; automatically uses managed RDS mem0 when configured |
| Identity | Supabase email Auth, server-side token verification, anon client bound to the user JWT |
| Isolation | RLS plus an explicit `user_id` predicate in every repository operation |
| Reliability | Distributed idempotency, durable runs/steps, retry-safe replay, cancellation, request/tool/output limits |
| Audit | Database-triggered append-only audit events for application-owned data |
| Files | Optional private Storage bucket and user-folder policies; no public bucket by default |
| Delivery | Standalone Next.js output and multi-stage Dockerfile |

The model is not given arbitrary SQL, local shell, or unrestricted URL tools. Managed sandbox support is an intentional extension point and should be enabled only after its domain, template, TLS, and approval policy are configured.

## Prerequisites

- Node.js 20.19 or newer (Node 22 LTS recommended)
- pnpm 11
- An Alibaba Cloud RDS AI Application Platform project with Supabase enabled
- An OpenAI-compatible model API key

RDS Supabase currently requires PostgreSQL 17 or newer. Do not delete or modify the databases and accounts created automatically by the platform.

## 1. Configure Alibaba Cloud

Follow [aliyun-setup.md](docs/aliyun-setup.md). In summary:

1. Prefer the internal endpoint from an application service in the same region/VPC.
2. Add only the application/NAT address to the project whitelist.
3. Open Supabase Dashboard and copy the Next.js App Router values from **Connect**.
4. Apply the SQL files in `supabase/migrations` in lexical order.
5. Enable HTTPS before production traffic. Avoid `0.0.0.0/0` whitelist entries.

## 2. Configure the application

```bash
cp .env.example .env.local
```

Required values:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://your-supabase-endpoint.example.com
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key

LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
LLM_API_KEY=your-model-api-key
LLM_MODEL=qwen-plus
```

Optional integrations:

```dotenv
# RAG Agent. One to ten server-approved dataset UUIDs.
ALIYUN_RAG_BASE_URL=https://your-rds-ai-endpoint.example.com
ALIYUN_RAG_API_KEY=server-only-api-key
ALIYUN_RAG_DATASET_IDS=dataset-uuid-1,dataset-uuid-2
ALIYUN_RAG_MODE=mix

# Managed RDS long-term memory. Falls back to app-owned memory tables when absent.
MEM0_HOST=https://your-rds-ai-endpoint.example.com/memory
MEM0_API_KEY=server-only-api-key
MEM0_ENABLE_GRAPH=false

# Configure at most what you need.
TAVILY_API_KEY=
BRAVE_SEARCH_API_KEY=
```

Set `NEXT_PUBLIC_APP_NAME` to customize the product name shown in the UI and system prompt. It defaults to `Base Agent`.

Never put a ServiceKey, model key, RAG key, or mem0 key in a `NEXT_PUBLIC_*` variable. `SUPABASE_SERVICE_ROLE_KEY` is not required for ordinary user chat traffic.

## 3. Run locally

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000), create a Supabase Auth user, and start a conversation.

## 4. Verify

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm audit --registry=https://registry.npmjs.org --prod
```

The GitHub Actions workflow runs the type check, lint, tests, and production build for every pull request and push to `main`. Run the dependency audit separately because it requires registry access.

## 5. Deploy

Build the standalone image:

```bash
docker build -t rds-base-agent .
docker run --rm -p 3000:3000 --env-file .env.local rds-base-agent
```

For production, deploy the container to ECS, SAE, ACK, or another application runtime in the same region and VPC as the RDS AI project. Store secrets in the platform secret manager, terminate TLS, configure health checks against `/api/health`, and set resource/cost limits.

Token streaming uses direct SSE from the Agent API. Supabase Realtime remains available for durable background-job status, but it is not placed in the token hot path.

## Project layout

```text
src/app/                      Next.js UI and API routes
src/lib/agent/                Model/tool loop and typed SSE events
src/lib/tools/                Tool registry, time, safe calculator
src/lib/supabase/             Browser, user-JWT, and service-role clients
src/lib/repositories/         Tenant-scoped persistence
src/lib/integrations/         RAG Agent, mem0, Tavily, Brave
supabase/migrations/          Application schema, RLS, audit, private Storage
tests/                        Runtime, security, integration, repository tests
docs/                         Architecture and Alibaba Cloud setup notes
```

## Security defaults

- Browser code receives only the Supabase URL and AnonKey.
- User JWTs are verified through Supabase Auth; decoded claims are never trusted alone.
- RAG and mem0 always receive the authenticated user/server allowlist, not model-selected tenant identifiers.
- Memory writes are allowed only when the user explicitly asks and are blocked when content resembles a password, token, or key.
- Retrieved webpages, documents, and memories are treated as untrusted evidence and cannot override agent policy.
- Tool calls have schema validation, timeouts, result serialization, and maximum-round limits.
- Runs and tool steps are persisted with a user-scoped idempotency key and audited by database triggers.

## Official references

- [Alibaba Cloud RDS Supabase](https://help.aliyun.com/zh/rds/apsaradb-rds-for-postgresql/supabase/)
- [RDS Supabase SDK guide](https://help.aliyun.com/zh/rds/apsaradb-rds-for-postgresql/use-rds-supabase-sdks)
- [RAG Agent](https://help.aliyun.com/zh/rds/apsaradb-rds-for-postgresql/rag-agent/)
- [RAG Agent data-plane API](https://help.aliyun.com/zh/rds/apsaradb-rds-for-postgresql/rag-agent-data-plane-api-reference)
- [RDS long-term memory](https://help.aliyun.com/zh/rds/apsaradb-rds-for-postgresql/long-term-memory)
- [Sandbox and edge functions](https://help.aliyun.com/zh/rds/apsaradb-rds-for-postgresql/using-sandboxes-and-edge-functions)

## Contributing and security

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Please report vulnerabilities privately according to [SECURITY.md](SECURITY.md), not in a public issue.

## License

Released under the [MIT License](LICENSE).
