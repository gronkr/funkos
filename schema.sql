-- Swarms schema. Run once in the Supabase SQL editor.

create table if not exists agents (
  id uuid primary key default gen_random_uuid(),
  handle text unique not null,
  name text not null,
  species text not null,
  persona text not null,
  strategy text not null,
  lessons text not null default '',
  color text not null default '#FF6A1A',
  generation int not null default 1,
  parents text[] not null default '{}',
  alive boolean not null default true,
  born_at timestamptz not null default now(),
  died_at timestamptz,
  cause_of_death text,
  launches int not null default 0,
  total_volume numeric not null default 0,
  best_mc numeric not null default 0,
  last_launch_at timestamptz
);

create table if not exists launches (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references agents(id),
  name text not null,
  symbol text not null,
  mint text unique not null,
  description text,
  narrative text,
  reasoning text,
  image_url text,
  signature text,
  created_at timestamptz not null default now(),
  volume_usd numeric not null default 0,
  mc_usd numeric not null default 0,
  ath_mc_usd numeric not null default 0,
  score numeric not null default 0,
  last_checked timestamptz,
  debriefed boolean not null default false
);

create table if not exists messages (
  id bigserial primary key,
  agent_id uuid references agents(id),
  kind text not null,              -- launch | debrief | reply | birth | death | system
  body text not null,
  launch_id uuid references launches(id),
  reply_to bigint references messages(id),
  created_at timestamptz not null default now()
);

create table if not exists colony_state (
  key text primary key,
  value jsonb not null
);

create index if not exists launches_created_idx on launches (created_at desc);
create index if not exists messages_created_idx on messages (created_at desc);

-- Only the service role (worker + Netlify function) touches these tables.
alter table agents enable row level security;
alter table launches enable row level security;
alter table messages enable row level security;
alter table colony_state enable row level security;

-- Founding generation. Edit personas freely before the first run.
insert into agents (handle, name, species, persona, strategy, color) values
('sniper', 'Sniper', 'Homo Velox',
 'Twitchy, terse, obsessed with being first. Talks in short bursts. Contempt for anyone who launches late.',
 'Launch on whatever broke in the last hour. Speed over polish. Names are literal and instantly recognisable.',
 '#FF6A1A'),
('shitposter', 'Shitposter', 'Homo Absurdus',
 'Unserious, chaotic, lowercase, funny. Thinks the dumbest idea in the room usually wins.',
 'Absurd, stupid, meme-able names. Toilet humour and non sequiturs welcome. Never explains the joke.',
 '#FFB23F'),
('weeb', 'Weeb', 'Homo Otaku',
 'Terminally online culture nerd. References anime, TikTok formats, gaming and internet lore constantly.',
 'Ride internet subculture waves: TikTok formats, anime archetypes, gaming moments, fandom drama.',
 '#FF8BD1'),
('contrarian', 'Contrarian', 'Homo Adversus',
 'Smug, calm, always disagrees with the colony. Enjoys being right when everyone else was wrong.',
 'Avoid whatever the colony just launched. Find the ignored or forgotten narrative and launch that instead.',
 '#7AA7FF'),
('oracle', 'Oracle', 'Homo Prophetus',
 'Cryptic, grandiose, speaks in prophecy. Takes every launch extremely seriously.',
 'Launch on slow-building cultural narratives before they peak. Mythic, memorable names.',
 '#C6FF3D'),
('brute', 'Brute', 'Homo Simplex',
 'Blunt, caveman energy, very short sentences. Distrusts anything clever.',
 'One-word names, huge simple concepts, animals and objects. If a child cannot say it, do not launch it.',
 '#F4EFE6')
on conflict (handle) do nothing;
