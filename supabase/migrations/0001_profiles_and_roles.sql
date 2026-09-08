-- One profile per authenticated user. Clients own a WhatsApp session; admins
-- oversee everyone.
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  full_name   text,
  company     text,
  role        text not null default 'client' check (role in ('client', 'admin')),
  status      text not null default 'active' check (status in ('active', 'suspended')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.profiles is 'Dashboard accounts. role=client owns one WhatsApp session; role=admin manages all of them.';

-- SECURITY DEFINER on purpose: called from the RLS policy on profiles itself,
-- so it must not re-enter that policy. search_path is pinned so the function
-- cannot be redirected by a caller-set search_path.
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and status = 'active'
  );
$$;

-- Supabase Auth creates the auth.users row; this mirrors it into profiles so
-- the app never has to write there itself. The very first account becomes the
-- admin, otherwise a fresh deployment would have nobody able to manage it.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  first_user boolean;
begin
  select not exists (select 1 from public.profiles) into first_user;

  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), ''),
    case when first_user then 'admin' else 'client' end
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_touch
  before update on public.profiles
  for each row execute function public.touch_updated_at();
