-- Every table is deny-by-default; the policies below are the only way in.
-- The server uses the service-role key and bypasses all of this, so these
-- policies govern what a browser holding a user's JWT can reach.
alter table public.profiles            enable row level security;
alter table public.wa_sessions         enable row level security;
alter table public.api_keys            enable row level security;
alter table public.usage_daily         enable row level security;
alter table public.audit_log           enable row level security;
alter table public.contacts            enable row level security;
alter table public.wa_messages         enable row level security;
alter table public.campaigns           enable row level security;
alter table public.campaign_recipients enable row level security;

-- ---- profiles -------------------------------------------------------------
create policy profiles_read on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_admin());

create policy profiles_update on public.profiles
  for update to authenticated
  using (id = auth.uid() or public.is_admin());

-- RLS cannot compare OLD and NEW, so role and status escalation is blocked
-- here instead. Without this a client could simply PATCH their own role to
-- admin, since they are allowed to update their own profile.
create or replace function public.guard_profile_privileges()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_admin() then
    return new;
  end if;
  if new.role is distinct from old.role then
    raise exception 'only an admin may change a role';
  end if;
  if new.status is distinct from old.status then
    raise exception 'only an admin may change account status';
  end if;
  return new;
end;
$$;

create trigger profiles_guard_privileges
  before update on public.profiles
  for each row execute function public.guard_profile_privileges();

-- ---- per-tenant tables ----------------------------------------------------
-- Read-only from the browser for anything the server owns the truth of
-- (sessions, keys, messages, usage): the client changes those through the API,
-- which validates and rate-limits, not by writing rows directly.
create policy wa_sessions_read on public.wa_sessions
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

create policy api_keys_read on public.api_keys
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

create policy usage_read on public.usage_daily
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

create policy audit_read on public.audit_log
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

create policy wa_messages_read on public.wa_messages
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- Contacts and campaigns are CRM data the client genuinely owns, so the
-- dashboard may edit them directly.
create policy contacts_read on public.contacts
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

create policy contacts_write on public.contacts
  for insert to authenticated
  with check (user_id = auth.uid());

create policy contacts_update on public.contacts
  for update to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

create policy contacts_delete on public.contacts
  for delete to authenticated
  using (user_id = auth.uid() or public.is_admin());

create policy campaigns_read on public.campaigns
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

create policy campaigns_write on public.campaigns
  for insert to authenticated
  with check (user_id = auth.uid());

create policy campaigns_update on public.campaigns
  for update to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

-- campaign_recipients carries no user_id, so ownership is reached through the
-- parent campaign rather than duplicated (and risking the two disagreeing).
create policy campaign_recipients_read on public.campaign_recipients
  for select to authenticated
  using (
    exists (
      select 1 from public.campaigns c
      where c.id = campaign_id and (c.user_id = auth.uid() or public.is_admin())
    )
  );

-- ---- function privileges --------------------------------------------------
-- Trigger functions execute as the table owner and never need EXECUTE granted
-- to a client role. A SECURITY DEFINER function callable by anon is exactly the
-- shape of a privilege-escalation bug, so take it away.
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.guard_profile_privileges() from public, anon, authenticated;
revoke all on function public.touch_updated_at() from public, anon, authenticated;

-- is_admin() is genuinely needed while evaluating the policies above, which run
-- as the querying role, so `authenticated` keeps it. Anonymous callers have no
-- business asking.
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated, service_role;
