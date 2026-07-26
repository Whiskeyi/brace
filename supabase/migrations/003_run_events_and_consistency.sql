-- Durable, ordered agent events and single-writer conversation semantics.
-- Apply after 001_agent_data.sql and 002_private_storage.sql.

begin;

alter table public.agent_runs
  add column if not exists heartbeat_at timestamptz;

-- Older releases did not serialize runs per conversation. During a drained
-- migration, deterministically retire every older duplicate before enforcing
-- the invariant so an existing stale row cannot roll back the whole migration.
with ranked_active_runs as (
  select id,
         row_number() over (
           partition by user_id, conversation_id
           order by coalesce(heartbeat_at, started_at, updated_at, created_at) desc, id desc
         ) as active_rank
  from public.agent_runs
  where conversation_id is not null
    and status in ('queued', 'running', 'requires_action')
)
update public.agent_runs as runs
set status = 'failed',
    error = jsonb_build_object(
      'code', 'migration_duplicate_active_run',
      'message', 'A newer active run superseded this run during migration 003.'
    ),
    heartbeat_at = now(),
    completed_at = now()
from ranked_active_runs as ranked
where runs.id = ranked.id and ranked.active_rank > 1;

create unique index if not exists agent_runs_one_active_conversation_idx
  on public.agent_runs (user_id, conversation_id)
  where conversation_id is not null
    and status in ('queued', 'running', 'requires_action');

create table if not exists public.agent_run_events (
  run_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  sequence integer not null,
  type text not null,
  event jsonb not null,
  created_at timestamptz not null default now(),
  primary key (run_id, sequence),
  constraint agent_run_events_run_owner_fk
    foreign key (run_id, user_id)
    references public.agent_runs(id, user_id) on delete cascade,
  constraint agent_run_events_sequence_positive check (sequence > 0),
  constraint agent_run_events_type_length check (char_length(type) between 1 and 64),
  constraint agent_run_events_event_object check (jsonb_typeof(event) = 'object')
);

create index if not exists agent_run_events_owner_run_idx
  on public.agent_run_events (user_id, run_id, sequence);

-- Retire the pre-event-log finalize prototype if this migration is reapplied
-- over an environment that evaluated an earlier draft. A changed PostgreSQL
-- function signature creates an overload instead of replacing the old RPC.
drop function if exists public.agent_finalize_run(
  uuid, uuid, uuid, text, jsonb, jsonb, jsonb, jsonb
);

create or replace function public.agent_begin_run(
  p_user_id uuid,
  p_idempotency_key text,
  p_conversation_id uuid,
  p_input jsonb,
  p_model text,
  p_run_metadata jsonb,
  p_user_content jsonb,
  p_user_metadata jsonb
)
returns public.agent_runs
language plpgsql
set search_path = pg_catalog, public
as $function$
declare
  created public.agent_runs;
begin
  if auth.uid() is distinct from p_user_id and current_user <> 'service_role' then
    raise exception 'agent run owner mismatch' using errcode = '42501';
  end if;

  insert into public.agent_runs (
    user_id,
    idempotency_key,
    conversation_id,
    status,
    input,
    model,
    metadata,
    started_at,
    heartbeat_at
  ) values (
    p_user_id,
    p_idempotency_key,
    p_conversation_id,
    'running',
    p_input,
    p_model,
    coalesce(p_run_metadata, '{}'::jsonb),
    now(),
    now()
  ) returning * into created;

  insert into public.agent_messages (
    user_id,
    conversation_id,
    role,
    content,
    metadata
  ) values (
    p_user_id,
    p_conversation_id,
    'user',
    p_user_content,
    coalesce(p_user_metadata, '{}'::jsonb)
  );

  return created;
end;
$function$;

create or replace function public.agent_finalize_run(
  p_user_id uuid,
  p_run_id uuid,
  p_conversation_id uuid,
  p_status text,
  p_output jsonb,
  p_error jsonb,
  p_assistant_content jsonb,
  p_assistant_metadata jsonb,
  p_terminal_sequence integer,
  p_terminal_type text,
  p_terminal_event jsonb
)
returns public.agent_runs
language plpgsql
set search_path = pg_catalog, public
as $function$
declare
  finalized public.agent_runs;
begin
  if auth.uid() is distinct from p_user_id and current_user <> 'service_role' then
    raise exception 'agent run owner mismatch' using errcode = '42501';
  end if;
  if p_status not in ('completed', 'failed', 'cancelled') then
    raise exception 'invalid terminal run status' using errcode = '22023';
  end if;
  if p_terminal_sequence < 1
     or p_terminal_type not in ('done', 'error')
     or jsonb_typeof(p_terminal_event) <> 'object'
     or p_terminal_event ->> 'runId' is distinct from p_run_id::text
     or p_terminal_event ->> 'type' is distinct from p_terminal_type
     or p_terminal_event ->> 'sequence' is distinct from p_terminal_sequence::text
     or (p_status = 'completed' and p_terminal_type <> 'done')
     or (p_status <> 'completed' and p_terminal_type <> 'error') then
    raise exception 'invalid terminal run event' using errcode = '22023';
  end if;

  select * into finalized
  from public.agent_runs
  where id = p_run_id
    and user_id = p_user_id
    and conversation_id = p_conversation_id
  for update;

  if finalized.id is null then
    raise exception 'agent run not found' using errcode = 'P0002';
  end if;

  -- A lost RPC response can be retried safely. The first transaction either
  -- committed the matching terminal event and projection, or changed nothing.
  if finalized.status in ('completed', 'failed', 'cancelled') then
    if finalized.status = p_status
       and finalized.output is not distinct from p_output
       and finalized.error is not distinct from p_error
       and exists (
         select 1
         from public.agent_run_events
         where run_id = p_run_id
           and user_id = p_user_id
           and sequence = p_terminal_sequence
           and type = p_terminal_type
           and event = p_terminal_event
       )
       and exists (
         select 1
         from public.agent_messages
         where user_id = p_user_id
           and conversation_id = p_conversation_id
           and role = 'assistant'
           and content = p_assistant_content
           and metadata = coalesce(p_assistant_metadata, '{}'::jsonb)
       ) then
      return finalized;
    end if;
    raise exception 'agent run is already terminal' using errcode = '40001';
  end if;

  if finalized.status not in ('running', 'requires_action') then
    raise exception 'agent run is not active' using errcode = '40001';
  end if;

  update public.agent_runs
  set status = p_status,
      output = p_output,
      error = p_error,
      heartbeat_at = now(),
      completed_at = now()
  where id = p_run_id
    and user_id = p_user_id
    and conversation_id = p_conversation_id
    and status = finalized.status
  returning * into finalized;

  insert into public.agent_run_events (
    run_id,
    user_id,
    sequence,
    type,
    event
  ) values (
    p_run_id,
    p_user_id,
    p_terminal_sequence,
    p_terminal_type,
    p_terminal_event
  );

  update public.agent_run_steps
  set status = case when p_status = 'cancelled' then 'cancelled' else 'failed' end,
      completed_at = now()
  where run_id = p_run_id
    and user_id = p_user_id
    and status in ('queued', 'running');

  insert into public.agent_messages (
    user_id,
    conversation_id,
    role,
    content,
    metadata
  ) values (
    p_user_id,
    p_conversation_id,
    'assistant',
    p_assistant_content,
    coalesce(p_assistant_metadata, '{}'::jsonb)
  );

  return finalized;
end;
$function$;

create or replace function public.agent_append_run_events(
  p_user_id uuid,
  p_run_id uuid,
  p_events jsonb
)
returns setof public.agent_run_events
language plpgsql
set search_path = pg_catalog, public
as $function$
declare
  owned_run public.agent_runs;
  item jsonb;
  event_sequence integer;
  event_type text;
  event_payload jsonb;
begin
  if auth.uid() is distinct from p_user_id and current_user <> 'service_role' then
    raise exception 'agent run owner mismatch' using errcode = '42501';
  end if;
  if jsonb_typeof(p_events) <> 'array'
     or jsonb_array_length(p_events) not between 1 and 100 then
    raise exception 'invalid run-event batch' using errcode = '22023';
  end if;

  select * into owned_run
  from public.agent_runs
  where id = p_run_id
    and user_id = p_user_id
    and status in ('running', 'requires_action')
  for update;
  if owned_run.id is null then
    raise exception 'agent run lease is not active' using errcode = '40001';
  end if;

  for item in
    select element
    from jsonb_array_elements(p_events) as batch(element)
  loop
    event_sequence := (item ->> 'sequence')::integer;
    event_type := item ->> 'type';
    event_payload := item -> 'event';
    if event_sequence < 1
       or char_length(event_type) not between 1 and 64
       or jsonb_typeof(event_payload) <> 'object'
       or event_payload ->> 'runId' is distinct from p_run_id::text
       or event_payload ->> 'sequence' is distinct from event_sequence::text
       or event_payload ->> 'type' is distinct from event_type then
      raise exception 'invalid run event' using errcode = '22023';
    end if;

    insert into public.agent_run_events (run_id, user_id, sequence, type, event)
    values (p_run_id, p_user_id, event_sequence, event_type, event_payload)
    on conflict (run_id, sequence) do nothing;

    if not exists (
      select 1 from public.agent_run_events
      where run_id = p_run_id
        and user_id = p_user_id
        and sequence = event_sequence
        and type = event_type
        and event = event_payload
    ) then
      raise exception 'run-event idempotency conflict' using errcode = '23505';
    end if;
  end loop;

  return query
  select events.*
  from public.agent_run_events as events
  where events.run_id = p_run_id
    and events.user_id = p_user_id
    and events.sequence in (
      select (element ->> 'sequence')::integer
      from jsonb_array_elements(p_events) as batch(element)
    )
  order by events.sequence;
end;
$function$;

create or replace function public.agent_recover_stale_run(
  p_user_id uuid,
  p_run_id uuid,
  p_conversation_id uuid,
  p_stale_after_seconds integer,
  p_error jsonb,
  p_assistant_metadata jsonb
)
returns public.agent_runs
language plpgsql
set search_path = pg_catalog, public
as $function$
declare
  recovered public.agent_runs;
  terminal_sequence integer;
  terminal_event jsonb;
begin
  if auth.uid() is distinct from p_user_id and current_user <> 'service_role' then
    raise exception 'agent run owner mismatch' using errcode = '42501';
  end if;
  if p_stale_after_seconds < 1
     or jsonb_typeof(p_error) <> 'object'
     or jsonb_typeof(coalesce(p_assistant_metadata, '{}'::jsonb)) <> 'object' then
    raise exception 'invalid stale-run recovery input' using errcode = '22023';
  end if;

  select * into recovered
  from public.agent_runs
  where id = p_run_id
    and user_id = p_user_id
    and conversation_id = p_conversation_id
    and status in ('queued', 'running', 'requires_action')
    and coalesce(heartbeat_at, started_at, updated_at, created_at)
      <= now() - make_interval(secs => p_stale_after_seconds)
  for update;

  if recovered.id is null then
    return null;
  end if;

  select coalesce(max(sequence), 0) + 1 into terminal_sequence
  from public.agent_run_events
  where run_id = p_run_id and user_id = p_user_id;
  terminal_event := jsonb_build_object(
    'protocolVersion', 1,
    'sequence', terminal_sequence,
    'timestamp', now(),
    'runId', p_run_id,
    'type', 'error',
    'error', p_error
  );

  update public.agent_runs
  set status = 'failed',
      output = jsonb_build_object('content', ''),
      error = p_error,
      heartbeat_at = now(),
      completed_at = now()
  where id = p_run_id and user_id = p_user_id
  returning * into recovered;

  update public.agent_run_steps
  set status = 'failed', completed_at = now()
  where run_id = p_run_id
    and user_id = p_user_id
    and status in ('queued', 'running');

  insert into public.agent_run_events (run_id, user_id, sequence, type, event)
  values (p_run_id, p_user_id, terminal_sequence, 'error', terminal_event);

  insert into public.agent_messages (
    user_id, conversation_id, role, content, metadata
  ) values (
    p_user_id,
    p_conversation_id,
    'assistant',
    '""'::jsonb,
    coalesce(p_assistant_metadata, '{}'::jsonb)
  );

  return recovered;
end;
$function$;

revoke all on function public.agent_begin_run(uuid, text, uuid, jsonb, text, jsonb, jsonb, jsonb) from public;
revoke all on function public.agent_finalize_run(uuid, uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, integer, text, jsonb) from public;
revoke all on function public.agent_append_run_events(uuid, uuid, jsonb) from public;
revoke all on function public.agent_recover_stale_run(uuid, uuid, uuid, integer, jsonb, jsonb) from public;
revoke all on function public.agent_begin_run(uuid, text, uuid, jsonb, text, jsonb, jsonb, jsonb) from authenticated;
revoke all on function public.agent_finalize_run(uuid, uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, integer, text, jsonb) from authenticated;
revoke all on function public.agent_append_run_events(uuid, uuid, jsonb) from authenticated;
revoke all on function public.agent_recover_stale_run(uuid, uuid, uuid, integer, jsonb, jsonb) from authenticated;
grant execute on function public.agent_begin_run(uuid, text, uuid, jsonb, text, jsonb, jsonb, jsonb) to service_role;
grant execute on function public.agent_finalize_run(uuid, uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, integer, text, jsonb) to service_role;
grant execute on function public.agent_append_run_events(uuid, uuid, jsonb) to service_role;
grant execute on function public.agent_recover_stale_run(uuid, uuid, uuid, integer, jsonb, jsonb) to service_role;

create or replace function public.agent_touch_conversation_from_message()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $function$
declare
  owner_id uuid;
  parent_id uuid;
begin
  owner_id := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
  parent_id := case when tg_op = 'DELETE' then old.conversation_id else new.conversation_id end;

  update public.agent_conversations
  set updated_at = now()
  where id = parent_id and user_id = owner_id;

  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;

revoke all on function public.agent_touch_conversation_from_message() from public;

drop trigger if exists agent_messages_touch_conversation on public.agent_messages;
create trigger agent_messages_touch_conversation
after insert or update or delete on public.agent_messages
for each row execute function public.agent_touch_conversation_from_message();

-- Token/delta events are intentionally not copied into the audit table. Run
-- transitions already produce audit rows, avoiding per-token write amplification.
drop trigger if exists agent_run_events_audit on public.agent_run_events;

alter table public.agent_run_events enable row level security;

drop policy if exists agent_run_events_select_own on public.agent_run_events;
create policy agent_run_events_select_own on public.agent_run_events
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists agent_run_events_insert_own on public.agent_run_events;
-- Events are append-only and server-owned. Authenticated browser clients receive
-- no INSERT, UPDATE, or DELETE policy and no table privileges below.

revoke all on table public.agent_run_events from public, anon;
revoke all on table public.agent_conversations from authenticated;
revoke all on table public.agent_messages from authenticated;
revoke all on table public.agent_runs from authenticated;
revoke all on table public.agent_run_steps from authenticated;
revoke all on table public.agent_memories from authenticated;
revoke all on table public.agent_audit_events from authenticated;
revoke all on table public.agent_run_events from authenticated;
grant select, insert on table public.agent_run_events to service_role;

comment on table public.agent_run_events is
  'Append-only, ordered AgentEvent envelopes used for replay and run diagnostics.';

commit;
