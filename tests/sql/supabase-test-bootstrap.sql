\set ON_ERROR_STOP on

create extension if not exists pgcrypto;

do $bootstrap$
begin
  create role anon nologin;
exception when duplicate_object then
  null;
end;
$bootstrap$;

do $bootstrap$
begin
  create role authenticated nologin;
exception when duplicate_object then
  null;
end;
$bootstrap$;

do $bootstrap$
begin
  create role service_role nologin bypassrls;
exception when duplicate_object then
  null;
end;
$bootstrap$;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key
);

create or replace function auth.uid()
returns uuid
language sql
stable
as $function$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$function$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

create schema if not exists storage;

create table if not exists storage.buckets (
  id text primary key,
  name text not null unique,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null references storage.buckets(id) on delete cascade,
  name text not null
);

alter table storage.objects enable row level security;

create or replace function storage.foldername(object_name text)
returns text[]
language sql
immutable
as $function$
  select string_to_array(object_name, '/');
$function$;

grant usage on schema storage to anon, authenticated, service_role;
grant select, insert, update, delete on storage.objects to authenticated, service_role;
