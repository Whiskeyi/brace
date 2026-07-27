\set ON_ERROR_STOP on

insert into auth.users (id)
values
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222');

insert into storage.objects (bucket_id, name)
values (
  'agent-private',
  '22222222-2222-4222-8222-222222222222/private.txt'
);

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';

insert into storage.objects (bucket_id, name)
values (
  'agent-private',
  '11111111-1111-4111-8111-111111111111/own.txt'
);

do $storage_rls$
declare
  affected_rows integer;
begin
  begin
    insert into storage.objects (bucket_id, name)
    values (
      'agent-private',
      '22222222-2222-4222-8222-222222222222/cross-tenant.txt'
    );
    raise exception 'cross-tenant storage insert unexpectedly succeeded';
  exception when insufficient_privilege then
    null;
  end;

  if exists (
    select 1
    from storage.objects
    where name = '22222222-2222-4222-8222-222222222222/private.txt'
  ) then
    raise exception 'cross-tenant storage select unexpectedly succeeded';
  end if;

  update storage.objects
  set name = '11111111-1111-4111-8111-111111111111/hijacked.txt'
  where name = '22222222-2222-4222-8222-222222222222/private.txt';
  get diagnostics affected_rows = row_count;
  if affected_rows <> 0 then
    raise exception 'cross-tenant storage update unexpectedly succeeded';
  end if;

  delete from storage.objects
  where name = '22222222-2222-4222-8222-222222222222/private.txt';
  get diagnostics affected_rows = row_count;
  if affected_rows <> 0 then
    raise exception 'cross-tenant storage delete unexpectedly succeeded';
  end if;
end;
$storage_rls$;

reset role;
reset request.jwt.claim.sub;

set role service_role;

insert into public.agent_conversations (id, user_id, title)
values (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '11111111-1111-4111-8111-111111111111',
  'Migration integration test'
);

select (
  public.agent_begin_run(
    '11111111-1111-4111-8111-111111111111',
    'integration-run-complete',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    jsonb_build_object('message', 'hello'),
    'integration-model',
    jsonb_build_object('requestHash', 'integration-hash'),
    to_jsonb('hello'::text),
    '{}'::jsonb
  )
).id as completed_run_id
\gset

select jsonb_build_object(
  'protocolVersion', 1,
  'sequence', 1,
  'timestamp', now(),
  'runId', :'completed_run_id',
  'type', 'start',
  'model', 'integration-model',
  'maxRounds', 2,
  'limits', jsonb_build_object(
    'maxRounds', 2,
    'maxToolCalls', 4,
    'maxToolConcurrency', 2,
    'maxModelOutputBytes', 4096,
    'toolTimeoutMs', 1000,
    'maxToolArgumentBytes', 1024,
    'maxToolResultBytes', 1024
  )
)::text as start_event
\gset

select count(*)
from public.agent_append_run_events(
  '11111111-1111-4111-8111-111111111111',
  :'completed_run_id'::uuid,
  jsonb_build_array(jsonb_build_object(
    'sequence', 1,
    'type', 'start',
    'event', :'start_event'::jsonb
  ))
);

-- An identical retry must return the existing row instead of duplicating it.
select count(*)
from public.agent_append_run_events(
  '11111111-1111-4111-8111-111111111111',
  :'completed_run_id'::uuid,
  jsonb_build_array(jsonb_build_object(
    'sequence', 1,
    'type', 'start',
    'event', :'start_event'::jsonb
  ))
);

insert into public.agent_run_steps (
  run_id,
  user_id,
  position,
  kind,
  status,
  input,
  metadata
) values (
  :'completed_run_id'::uuid,
  '11111111-1111-4111-8111-111111111111',
  0,
  'tool_call',
  'running',
  '{}'::jsonb,
  '{}'::jsonb
);

select jsonb_build_object(
  'protocolVersion', 1,
  'sequence', 2,
  'timestamp', now(),
  'runId', :'completed_run_id',
  'type', 'done',
  'content', 'ok',
  'finishReason', 'stop',
  'rounds', 1,
  'usage', jsonb_build_object(
    'promptTokens', 1,
    'completionTokens', 1,
    'totalTokens', 2
  )
)::text as terminal_event
\gset

select
  jsonb_build_object(
    'content', 'ok',
    'rounds', 1,
    'usage', jsonb_build_object(
      'promptTokens', 1,
      'completionTokens', 1,
      'totalTokens', 2
    )
  )::text as final_output,
  to_jsonb('ok'::text)::text as assistant_content,
  jsonb_build_object('status', 'completed')::text as assistant_metadata
\gset

select (
  public.agent_finalize_run(
    '11111111-1111-4111-8111-111111111111',
    :'completed_run_id'::uuid,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'completed',
    :'final_output'::jsonb,
    null,
    :'assistant_content'::jsonb,
    :'assistant_metadata'::jsonb,
    2,
    'done',
    :'terminal_event'::jsonb
  )
).status;

-- A lost-response retry with the same terminal envelope is idempotent.
select (
  public.agent_finalize_run(
    '11111111-1111-4111-8111-111111111111',
    :'completed_run_id'::uuid,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'completed',
    :'final_output'::jsonb,
    null,
    :'assistant_content'::jsonb,
    :'assistant_metadata'::jsonb,
    2,
    'done',
    :'terminal_event'::jsonb
  )
).status;

do $finalize_conflict$
declare
  completed_run public.agent_runs;
  completed_event public.agent_run_events;
begin
  select * into strict completed_run
  from public.agent_runs
  where idempotency_key = 'integration-run-complete';

  select * into strict completed_event
  from public.agent_run_events
  where run_id = completed_run.id and type = 'done';

  begin
    perform public.agent_finalize_run(
      completed_run.user_id,
      completed_run.id,
      completed_run.conversation_id,
      'completed',
      jsonb_build_object('content', 'tampered'),
      null,
      to_jsonb('ok'::text),
      jsonb_build_object('status', 'completed'),
      completed_event.sequence,
      completed_event.type,
      completed_event.event
    );
    raise exception 'conflicting finalize retry unexpectedly succeeded';
  exception when serialization_failure then
    null;
  end;
end;
$finalize_conflict$;

select (
  public.agent_begin_run(
    '11111111-1111-4111-8111-111111111111',
    'integration-run-stale',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    jsonb_build_object('message', 'stale'),
    'integration-model',
    '{}'::jsonb,
    to_jsonb('stale'::text),
    '{}'::jsonb
  )
).id as stale_run_id
\gset

update public.agent_runs
set heartbeat_at = now() - interval '10 minutes'
where id = :'stale_run_id'::uuid;

select (
  public.agent_recover_stale_run(
    '11111111-1111-4111-8111-111111111111',
    :'stale_run_id'::uuid,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    60,
    jsonb_build_object(
      'code', 'llm_error',
      'message', 'lease expired',
      'retryable', true
    ),
    jsonb_build_object('status', 'failed')
  )
).status;

do $fresh_lease$
declare
  fresh_run public.agent_runs;
  recovered public.agent_runs;
begin
  select * into strict fresh_run
  from public.agent_begin_run(
    '11111111-1111-4111-8111-111111111111',
    'integration-run-fresh',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    jsonb_build_object('message', 'fresh'),
    'integration-model',
    '{}'::jsonb,
    to_jsonb('fresh'::text),
    '{}'::jsonb
  );

  select * into recovered
  from public.agent_recover_stale_run(
    '11111111-1111-4111-8111-111111111111',
    fresh_run.id,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    3600,
    jsonb_build_object(
      'code', 'llm_error',
      'message', 'must stay active',
      'retryable', true
    ),
    '{}'::jsonb
  );
  if recovered.id is not null then
    raise exception 'fresh run was incorrectly recovered as stale';
  end if;

  begin
    perform public.agent_begin_run(
      '11111111-1111-4111-8111-111111111111',
      'integration-run-second-active',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      jsonb_build_object('message', 'must conflict'),
      'integration-model',
      '{}'::jsonb,
      to_jsonb('must conflict'::text),
      '{}'::jsonb
    );
    raise exception 'second active conversation run unexpectedly succeeded';
  exception when unique_violation then
    null;
  end;
end;
$fresh_lease$;

reset role;

do $verify$
declare
  checked_role text;
  checked_table text;
  checked_function text;
begin
  if (
    select status
    from public.agent_runs
    where idempotency_key = 'integration-run-complete'
  ) is distinct from 'completed' then
    raise exception 'finalized run projection is invalid';
  end if;

  if (
    select count(*) <> 2
    from public.agent_run_events as events
    join public.agent_runs as runs on runs.id = events.run_id
    where runs.idempotency_key = 'integration-run-complete'
  ) then
    raise exception 'event append/finalize is not idempotent';
  end if;

  if (
    select steps.status
    from public.agent_run_steps as steps
    join public.agent_runs as runs on runs.id = steps.run_id
    where runs.idempotency_key = 'integration-run-complete'
  ) is distinct from 'failed' then
    raise exception 'terminal finalization did not close unfinished steps';
  end if;

  if (
    select status
    from public.agent_runs
    where idempotency_key = 'integration-run-stale'
  ) is distinct from 'failed' then
    raise exception 'stale lease recovery did not finalize the run';
  end if;

  if (
    select count(*) <> 5
    from public.agent_messages
    where conversation_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ) then
    raise exception 'transactional user/assistant message projections are invalid';
  end if;

  if (
    select count(*) <> 2
    from storage.objects
    where bucket_id = 'agent-private'
  ) then
    raise exception 'storage RLS cross-tenant test produced an invalid projection';
  end if;

  if not exists (
    select 1
    from storage.objects
    where name = '22222222-2222-4222-8222-222222222222/private.txt'
  ) then
    raise exception 'storage RLS allowed a cross-tenant mutation';
  end if;

  if (
    select count(*) <> 1
    from public.agent_runs
    where conversation_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      and status in ('queued', 'running', 'requires_action')
  ) or (
    select count(*) <> 1
    from public.agent_runs
    where conversation_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      and status = 'failed'
      and error ->> 'code' = 'migration_duplicate_active_run'
  ) then
    raise exception 'legacy duplicate active runs were not retired deterministically';
  end if;

  if (
    select status
    from public.agent_runs
    where id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2'
  ) is distinct from 'requires_action' or (
    select status
    from public.agent_runs
    where id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1'
  ) is distinct from 'failed' then
    raise exception 'legacy active-run retirement was not deterministic';
  end if;

  if (
    select status
    from public.agent_runs
    where idempotency_key = 'integration-run-fresh'
  ) is distinct from 'running' then
    raise exception 'fresh heartbeat lease did not remain active';
  end if;

  foreach checked_role in array array['anon', 'authenticated'] loop
    foreach checked_table in array array[
      'public.agent_conversations',
      'public.agent_messages',
      'public.agent_runs',
      'public.agent_run_steps',
      'public.agent_memories',
      'public.agent_audit_events',
      'public.agent_run_events'
    ] loop
      if has_table_privilege(checked_role, checked_table, 'SELECT')
         or has_table_privilege(checked_role, checked_table, 'INSERT')
         or has_table_privilege(checked_role, checked_table, 'UPDATE')
         or has_table_privilege(checked_role, checked_table, 'DELETE')
         or has_table_privilege(checked_role, checked_table, 'TRUNCATE')
         or has_table_privilege(checked_role, checked_table, 'REFERENCES')
         or has_table_privilege(checked_role, checked_table, 'TRIGGER') then
        raise exception '% retained privileges on %', checked_role, checked_table;
      end if;
    end loop;

    foreach checked_function in array array[
      'public.agent_begin_run(uuid,text,uuid,jsonb,text,jsonb,jsonb,jsonb)',
      'public.agent_finalize_run(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,integer,text,jsonb)',
      'public.agent_append_run_events(uuid,uuid,jsonb)',
      'public.agent_recover_stale_run(uuid,uuid,uuid,integer,jsonb,jsonb)'
    ] loop
      if has_function_privilege(checked_role, checked_function, 'EXECUTE') then
        raise exception '% retained RPC execution on %', checked_role, checked_function;
      end if;
    end loop;
  end loop;

  if has_table_privilege('service_role', 'public.agent_run_events', 'UPDATE')
     or has_table_privilege('service_role', 'public.agent_run_events', 'DELETE')
     or not has_table_privilege('service_role', 'public.agent_run_events', 'SELECT')
     or not has_table_privilege('service_role', 'public.agent_run_events', 'INSERT') then
    raise exception 'run event table is not append-only for the Service Role';
  end if;

  if to_regprocedure(
    'public.agent_finalize_run(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)'
  ) is not null then
    raise exception 'obsolete finalize RPC overload is still installed';
  end if;

  if not has_function_privilege(
    'service_role',
    'public.agent_finalize_run(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,integer,text,jsonb)',
    'EXECUTE'
  ) then
    raise exception 'Service Role cannot execute the run-control RPCs';
  end if;
end;
$verify$;
