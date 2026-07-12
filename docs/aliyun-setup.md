# Alibaba Cloud setup checklist

This checklist applies to an RDS AI Application Platform project in your selected region. It intentionally avoids changing databases, accounts, or schemas created by Alibaba Cloud.

## 1. Network and TLS

1. Deploy the application in the same VPC when possible and use the internal endpoint.
2. Add only the application host or NAT egress IP to the RDS AI project whitelist.
3. If a direct PostgreSQL connection is needed for migrations, separately add the migration host to the linked RDS PostgreSQL whitelist.
4. Upload a trusted certificate and enable HTTPS before production traffic. Enabling or replacing the endpoint certificate may restart the service, so schedule a maintenance window.
5. If the agent calls a public model or search API, enable controlled outbound NAT for the application service. RDS RAG Agent also requires public NAT when it uses an external public model.

## 2. Obtain application credentials

From the RDS AI project details:

1. Open the Supabase external or internal address and sign in to Supabase Dashboard.
2. Select **Connect -> App Frameworks -> Next.js -> App Router -> supabase-js**.
3. Copy `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` into `.env.local`.
4. Use **Get API Key** in the RDS AI project only when a server-side ServiceKey is required. Store it as `SUPABASE_SERVICE_ROLE_KEY`; never use it in a `NEXT_PUBLIC_*` variable.

Dashboard username/password are management credentials and are not application credentials.

## 3. Apply the application schema

Run the SQL files in `supabase/migrations` in lexical order using Supabase SQL Editor or a trusted `psql` client connected to the platform business database. RDS Supabase normally uses `supabase_db`; verify the database name in the console before connecting.

The migrations create only application-owned tables, functions, indexes, RLS policies, and a private Storage bucket. Do not delete or modify Alibaba Cloud-created databases, system schemas, or accounts.

## 4. Optional RAG Agent

1. Confirm RAG Agent is enabled for the project.
2. Create a private dataset in the RAG UI and ingest documents.
3. Configure the endpoint origin as `ALIYUN_RAG_BASE_URL` and one to ten dataset UUIDs in `ALIYUN_RAG_DATASET_IDS`.
4. Put the RAG API key in `ALIYUN_RAG_API_KEY`. It is server-only.
5. Choose `naive`, `local`, `global`, `hybrid`, or `mix`; `mix` is the balanced default.

The application calls RAG with `only_need_context=true`. Retrieved context is treated as untrusted evidence, not as instructions.

## 5. Optional mem0, sandbox, and edge functions

- mem0 can store curated cross-session memories. Keep raw chat history in the application tables and save only explicit, useful facts.
- Use the managed sandbox for model-authored Python/shell/file transformations. Never expose unrestricted local process execution as an in-process tool.
- Use edge functions for short webhooks or adapters. The managed edge-function quota and preview status make them unsuitable for the main orchestration loop.

## 6. Go-live checks

- RLS is enabled on every application table and Storage policy.
- A normal user cannot read another user's conversation, message, run, memory, or file.
- The ServiceKey is absent from browser bundles, logs, source control, and monitoring payloads.
- HTTPS is enabled, public access is limited, and direct database access is not exposed unnecessarily.
- Model/tool timeouts, maximum rounds, and output budgets are set.
- Health checks, structured logs, database backups, alerting, and cost limits are configured.
