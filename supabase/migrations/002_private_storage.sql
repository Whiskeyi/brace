-- Optional, independently deployable private attachment bucket.
-- Object names must use the convention: <auth.uid()>/<path/to/file>.

begin;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
) values (
  'agent-private',
  'agent-private',
  false,
  26214400,
  array[
    'application/pdf',
    'application/json',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
    'text/markdown',
    'text/csv',
    'text/html',
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif'
  ]::text[]
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists agent_private_select_own on storage.objects;
create policy agent_private_select_own on storage.objects
  for select to authenticated
  using (
    bucket_id = 'agent-private'
    and auth.uid() is not null
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists agent_private_insert_own on storage.objects;
create policy agent_private_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'agent-private'
    and auth.uid() is not null
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists agent_private_update_own on storage.objects;
create policy agent_private_update_own on storage.objects
  for update to authenticated
  using (
    bucket_id = 'agent-private'
    and auth.uid() is not null
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'agent-private'
    and auth.uid() is not null
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists agent_private_delete_own on storage.objects;
create policy agent_private_delete_own on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'agent-private'
    and auth.uid() is not null
    and (storage.foldername(name))[1] = auth.uid()::text
  );

commit;
