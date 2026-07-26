\set ON_ERROR_STOP on

-- Exercise migration 003 as an upgrade, not only as a fresh installation.
-- PostgreSQL keeps old overloads when a function signature changes.
create or replace function public.agent_finalize_run(
  uuid,
  uuid,
  uuid,
  text,
  jsonb,
  jsonb,
  jsonb,
  jsonb
)
returns public.agent_runs
language plpgsql
as $function$
begin
  return null;
end;
$function$;

grant execute on function public.agent_finalize_run(
  uuid, uuid, uuid, text, jsonb, jsonb, jsonb, jsonb
) to authenticated;

insert into auth.users (id)
values ('33333333-3333-4333-8333-333333333333');

insert into public.agent_conversations (id, user_id, title)
values (
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  '33333333-3333-4333-8333-333333333333',
  'Legacy duplicate-run fixture'
);

insert into public.agent_runs (
  id,
  conversation_id,
  user_id,
  idempotency_key,
  status,
  input
) values
  (
    'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '33333333-3333-4333-8333-333333333333',
    'legacy-active-run-0001',
    'running',
    '{}'::jsonb
  ),
  (
    'cccccccc-cccc-4ccc-8ccc-ccccccccccc2',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '33333333-3333-4333-8333-333333333333',
    'legacy-active-run-0002',
    'requires_action',
    '{}'::jsonb
  );
