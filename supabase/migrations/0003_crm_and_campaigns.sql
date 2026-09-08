-- Leads and customers, scoped to the client who owns them.
create table public.contacts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  jid             text not null,
  number          text,
  name            text,
  is_group        boolean not null default false,
  status          text not null default 'new'
                  check (status in ('new','open','qualified','won','lost','customer')),
  tags            text[] not null default '{}',
  notes           text,
  -- Sales guardrails. opted_out is honoured by every send path, and consent
  -- records how the contact became reachable, because "we bought a list" is how
  -- numbers get banned.
  opted_out       boolean not null default false,
  consent         text,
  last_message_at timestamptz,
  unread          integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, jid)
);

create index contacts_recent on public.contacts(user_id, last_message_at desc nulls last);
create index contacts_status on public.contacts(user_id, status);
create index contacts_tags on public.contacts using gin(tags);

create trigger contacts_touch
  before update on public.contacts
  for each row execute function public.touch_updated_at();

-- Named wa_messages, not messages: generic names are how two apps end up
-- fighting over one table.
create table public.wa_messages (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  wa_id       text,
  jid         text not null,
  direction   text not null check (direction in ('in','out')),
  participant text,
  push_name   text,
  type        text,
  body        text,
  sent_at     timestamptz not null,
  status      text,
  campaign_id uuid,
  error       text,
  created_at  timestamptz not null default now(),
  unique (user_id, wa_id)
);

create index wa_messages_thread on public.wa_messages(user_id, jid, sent_at desc);
create index wa_messages_recent on public.wa_messages(user_id, sent_at desc);
create index wa_messages_campaign on public.wa_messages(campaign_id) where campaign_id is not null;

create table public.campaigns (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  name        text not null,
  template    text not null,
  segment     jsonb,
  status      text not null default 'draft'
              check (status in ('draft','running','paused','done','cancelled')),
  created_at  timestamptz not null default now(),
  started_at  timestamptz,
  finished_at timestamptz
);

create index campaigns_user on public.campaigns(user_id, created_at desc);

create table public.campaign_recipients (
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  contact_id  uuid not null references public.contacts(id) on delete cascade,
  status      text not null default 'pending'
              check (status in ('pending','sent','skipped','failed')),
  wa_id       text,
  reason      text,
  sent_at     timestamptz,
  primary key (campaign_id, contact_id)
);

create index campaign_recipients_status on public.campaign_recipients(campaign_id, status);

alter table public.wa_messages
  add constraint wa_messages_campaign_fk
  foreign key (campaign_id) references public.campaigns(id) on delete set null;
