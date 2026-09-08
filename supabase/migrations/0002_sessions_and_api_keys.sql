-- One WhatsApp connection per client. The Baileys credential files stay on the
-- server's disk; this row is the metadata the dashboards read.
create table public.wa_sessions (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null unique references public.profiles(id) on delete cascade,
  state             text not null default 'idle'
                    check (state in ('idle','connecting','awaiting_scan','connected','logged_out','error')),
  wa_jid            text,
  wa_name           text,
  qr_updated_at     timestamptz,
  last_connected_at timestamptz,
  last_error        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on column public.wa_sessions.state is 'Mirrors the live socket. Never trust it as the source of truth; the server owns that.';

create trigger wa_sessions_touch
  before update on public.wa_sessions
  for each row execute function public.touch_updated_at();

-- API keys the client uses for machine access. Only a SHA-256 is stored, so a
-- leaked table cannot be replayed, and the plaintext is shown exactly once.
create table public.api_keys (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  name         text not null default 'default',
  key_prefix   text not null,
  key_hash     text not null unique,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

create index api_keys_user on public.api_keys(user_id) where revoked_at is null;
create index api_keys_hash on public.api_keys(key_hash) where revoked_at is null;

comment on column public.api_keys.key_prefix is 'First few characters, for telling keys apart in the UI. Not a secret.';

-- Per-day counters, so the admin dashboard does not aggregate the whole message
-- table on every page load.
create table public.usage_daily (
  user_id  uuid not null references public.profiles(id) on delete cascade,
  day      date not null,
  sent     integer not null default 0,
  received integer not null default 0,
  failed   integer not null default 0,
  primary key (user_id, day)
);

create table public.audit_log (
  id      bigserial primary key,
  at      timestamptz not null default now(),
  user_id uuid references public.profiles(id) on delete set null,
  actor   text,
  action  text not null,
  detail  jsonb
);

create index audit_log_recent on public.audit_log(at desc);
create index audit_log_user on public.audit_log(user_id, at desc);
