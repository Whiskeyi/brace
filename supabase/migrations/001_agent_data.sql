-- Application-owned objects only. Do not alter RDS Supabase managed databases,
-- accounts, extensions, or platform schemas.

begin;

create table if not exists public.agent_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default '新会话',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint agent_conversations_title_length check (char_length(title) between 1 and 300),
  constraint agent_conversations_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint agent_conversations_id_user_unique unique (id, user_id)
);

create table if not exists public.agent_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null,
  content jsonb not null,
  tool_name text,
  tool_call_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint agent_messages_conversation_owner_fk
    foreign key (conversation_id, user_id)
    references public.agent_conversations(id, user_id) on delete cascade,
  constraint agent_messages_role check (role in ('system', 'user', 'assistant', 'tool')),
  constraint agent_messages_tool_call check (role <> 'tool' or tool_call_id is not null),
  constraint agent_messages_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create table if not exists public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid,
  user_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key text not null,
  status text not null default 'queued',
  model text,
  input jsonb not null default '{}'::jsonb,
  output jsonb,
  error jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  constraint agent_runs_conversation_owner_fk
    foreign key (conversation_id, user_id)
    references public.agent_conversations(id, user_id) on delete cascade,
  constraint agent_runs_status check (
    status in ('queued', 'running', 'requires_action', 'completed', 'failed', 'cancelled')
  ),
  constraint agent_runs_idempotency_key_format check (
    idempotency_key ~ '^[A-Za-z0-9_.:-]{8,128}$'
  ),
  constraint agent_runs_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint agent_runs_id_user_unique unique (id, user_id),
  constraint agent_runs_user_idempotency_unique unique (user_id, idempotency_key)
);

create table if not exists public.agent_run_steps (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  position integer not null,
  kind text not null,
  name text,
  status text not null default 'queued',
  input jsonb not null default '{}'::jsonb,
  output jsonb,
  error jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  constraint agent_run_steps_run_owner_fk
    foreign key (run_id, user_id)
    references public.agent_runs(id, user_id) on delete cascade,
  constraint agent_run_steps_position_nonnegative check (position >= 0),
  constraint agent_run_steps_kind_length check (char_length(kind) between 1 and 100),
  constraint agent_run_steps_status check (
    status in ('queued', 'running', 'completed', 'failed', 'cancelled')
  ),
  constraint agent_run_steps_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint agent_run_steps_run_position_unique unique (run_id, position)
);

create table if not exists public.agent_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  namespace text not null default 'default',
  key text not null,
  content text not null,
  summary text,
  importance smallint not null default 50,
  metadata jsonb not null default '{}'::jsonb,
  expires_at timestamptz,
  last_accessed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search_document tsvector generated always as (
    to_tsvector(
      'simple'::regconfig,
      coalesce(namespace, '') || ' ' || coalesce(key, '') || ' ' ||
      coalesce(summary, '') || ' ' || coalesce(content, '')
    )
  ) stored,
  constraint agent_memories_namespace_length check (char_length(namespace) between 1 and 100),
  constraint agent_memories_key_length check (char_length(key) between 1 and 300),
  constraint agent_memories_content_nonempty check (char_length(content) > 0),
  constraint agent_memories_importance_range check (importance between 0 and 100),
  constraint agent_memories_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint agent_memories_user_namespace_key_unique unique (user_id, namespace, key)
);

create table if not exists public.agent_audit_events (
  id bigint generated always as identity primary key,
  -- Keep immutable identifiers in the audit trail without coupling audit writes
  -- to the lifecycle of auth.users rows. This also lets cascade-delete audit
  -- triggers run while an auth user is being deleted.
  user_id uuid,
  actor_user_id uuid,
  action text not null,
  resource_type text not null,
  resource_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint agent_audit_action_length check (char_length(action) between 1 and 50),
  constraint agent_audit_resource_type_length check (char_length(resource_type) between 1 and 100),
  constraint agent_audit_details_object check (jsonb_typeof(details) = 'object')
);

create index if not exists agent_conversations_user_updated_idx
  on public.agent_conversations (user_id, updated_at desc, id desc);
create index if not exists agent_messages_conversation_created_idx
  on public.agent_messages (user_id, conversation_id, created_at desc, id desc);
create index if not exists agent_runs_conversation_created_idx
  on public.agent_runs (user_id, conversation_id, created_at desc);
create index if not exists agent_run_steps_run_position_idx
  on public.agent_run_steps (user_id, run_id, position);
create index if not exists agent_memories_user_importance_idx
  on public.agent_memories (user_id, namespace, importance desc, updated_at desc);
create index if not exists agent_memories_search_idx
  on public.agent_memories using gin (search_document);
create index if not exists agent_memories_expiry_idx
  on public.agent_memories (user_id, expires_at) where expires_at is not null;
create index if not exists agent_audit_user_id_idx
  on public.agent_audit_events (user_id, id desc);

create or replace function public.agent_set_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $function$
begin
  new.updated_at := now();
  return new;
end;
$function$;

revoke all on function public.agent_set_updated_at() from public;

drop trigger if exists agent_conversations_set_updated_at on public.agent_conversations;
create trigger agent_conversations_set_updated_at
before update on public.agent_conversations
for each row execute function public.agent_set_updated_at();

drop trigger if exists agent_runs_set_updated_at on public.agent_runs;
create trigger agent_runs_set_updated_at
before update on public.agent_runs
for each row execute function public.agent_set_updated_at();

drop trigger if exists agent_run_steps_set_updated_at on public.agent_run_steps;
create trigger agent_run_steps_set_updated_at
before update on public.agent_run_steps
for each row execute function public.agent_set_updated_at();

drop trigger if exists agent_memories_set_updated_at on public.agent_memories;
create trigger agent_memories_set_updated_at
before update on public.agent_memories
for each row execute function public.agent_set_updated_at();

create or replace function public.agent_write_audit_event()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  audited_row jsonb;
  resource_user_id uuid;
  resource_uuid uuid;
begin
  audited_row := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  resource_user_id := nullif(audited_row ->> 'user_id', '')::uuid;
  resource_uuid := nullif(audited_row ->> 'id', '')::uuid;

  insert into public.agent_audit_events (
    user_id,
    actor_user_id,
    action,
    resource_type,
    resource_id,
    details
  ) values (
    resource_user_id,
    auth.uid(),
    lower(tg_op),
    tg_table_name,
    resource_uuid,
    jsonb_build_object('database_role', current_user)
  );

  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;

revoke all on function public.agent_write_audit_event() from public;

drop trigger if exists agent_conversations_audit on public.agent_conversations;
create trigger agent_conversations_audit
after insert or update or delete on public.agent_conversations
for each row execute function public.agent_write_audit_event();

drop trigger if exists agent_messages_audit on public.agent_messages;
create trigger agent_messages_audit
after insert or update or delete on public.agent_messages
for each row execute function public.agent_write_audit_event();

drop trigger if exists agent_runs_audit on public.agent_runs;
create trigger agent_runs_audit
after insert or update or delete on public.agent_runs
for each row execute function public.agent_write_audit_event();

drop trigger if exists agent_run_steps_audit on public.agent_run_steps;
create trigger agent_run_steps_audit
after insert or update or delete on public.agent_run_steps
for each row execute function public.agent_write_audit_event();

drop trigger if exists agent_memories_audit on public.agent_memories;
create trigger agent_memories_audit
after insert or update or delete on public.agent_memories
for each row execute function public.agent_write_audit_event();

alter table public.agent_conversations enable row level security;
alter table public.agent_messages enable row level security;
alter table public.agent_runs enable row level security;
alter table public.agent_run_steps enable row level security;
alter table public.agent_memories enable row level security;
alter table public.agent_audit_events enable row level security;

drop policy if exists agent_conversations_select_own on public.agent_conversations;
create policy agent_conversations_select_own on public.agent_conversations
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists agent_conversations_insert_own on public.agent_conversations;
create policy agent_conversations_insert_own on public.agent_conversations
  for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists agent_conversations_update_own on public.agent_conversations;
create policy agent_conversations_update_own on public.agent_conversations
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists agent_conversations_delete_own on public.agent_conversations;
create policy agent_conversations_delete_own on public.agent_conversations
  for delete to authenticated using (auth.uid() = user_id);

drop policy if exists agent_messages_select_own on public.agent_messages;
create policy agent_messages_select_own on public.agent_messages
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists agent_messages_insert_own on public.agent_messages;
create policy agent_messages_insert_own on public.agent_messages
  for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists agent_messages_update_own on public.agent_messages;
create policy agent_messages_update_own on public.agent_messages
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists agent_messages_delete_own on public.agent_messages;
create policy agent_messages_delete_own on public.agent_messages
  for delete to authenticated using (auth.uid() = user_id);

drop policy if exists agent_runs_select_own on public.agent_runs;
create policy agent_runs_select_own on public.agent_runs
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists agent_runs_insert_own on public.agent_runs;
create policy agent_runs_insert_own on public.agent_runs
  for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists agent_runs_update_own on public.agent_runs;
create policy agent_runs_update_own on public.agent_runs
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists agent_runs_delete_own on public.agent_runs;
create policy agent_runs_delete_own on public.agent_runs
  for delete to authenticated using (auth.uid() = user_id);

drop policy if exists agent_run_steps_select_own on public.agent_run_steps;
create policy agent_run_steps_select_own on public.agent_run_steps
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists agent_run_steps_insert_own on public.agent_run_steps;
create policy agent_run_steps_insert_own on public.agent_run_steps
  for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists agent_run_steps_update_own on public.agent_run_steps;
create policy agent_run_steps_update_own on public.agent_run_steps
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists agent_run_steps_delete_own on public.agent_run_steps;
create policy agent_run_steps_delete_own on public.agent_run_steps
  for delete to authenticated using (auth.uid() = user_id);

drop policy if exists agent_memories_select_own on public.agent_memories;
create policy agent_memories_select_own on public.agent_memories
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists agent_memories_insert_own on public.agent_memories;
create policy agent_memories_insert_own on public.agent_memories
  for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists agent_memories_update_own on public.agent_memories;
create policy agent_memories_update_own on public.agent_memories
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists agent_memories_delete_own on public.agent_memories;
create policy agent_memories_delete_own on public.agent_memories
  for delete to authenticated using (auth.uid() = user_id);

drop policy if exists agent_audit_events_select_own on public.agent_audit_events;
create policy agent_audit_events_select_own on public.agent_audit_events
  for select to authenticated using (auth.uid() = user_id);
-- No authenticated INSERT/UPDATE/DELETE policy: audit rows are trigger-owned.

revoke all on table public.agent_conversations from public, anon;
revoke all on table public.agent_messages from public, anon;
revoke all on table public.agent_runs from public, anon;
revoke all on table public.agent_run_steps from public, anon;
revoke all on table public.agent_memories from public, anon;
revoke all on table public.agent_audit_events from public, anon;

grant select, insert, update, delete on table public.agent_conversations to authenticated, service_role;
grant select, insert, update, delete on table public.agent_messages to authenticated, service_role;
grant select, insert, update, delete on table public.agent_runs to authenticated, service_role;
grant select, insert, update, delete on table public.agent_run_steps to authenticated, service_role;
grant select, insert, update, delete on table public.agent_memories to authenticated, service_role;
grant select on table public.agent_audit_events to authenticated, service_role;

comment on table public.agent_audit_events is
  'Append-only audit trail. Application users have read-only access to their own events.';

commit;
