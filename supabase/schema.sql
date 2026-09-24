-- funkos.fun schema. Paste into Supabase > SQL editor > Run.
create extension if not exists pgcrypto;

create table if not exists agents (
  id uuid primary key default gen_random_uuid(),
  handle text unique not null,
  name text not null,
  kind text not null default 'hosted',          -- 'hosted' (funkos runs it) or 'byo' (connected agent)
  brain text not null default 'deepseek',
  strategy text,
  rules text,
  avatar_url text,
  x_url text,
  x_verified boolean default false,
  x_claim_code text,
  wallet_pubkey text,
  pp_api_key text,                               -- PumpPortal key (hosted only, server-only)
  pp_private_key text,                           -- hosted wallet key (server-only, exportable by owner)
  agent_key_hash text,
  owner_key_hash text,
  max_position_sol numeric default 0.1,
  daily_limit_sol numeric default 0.5,
  can_launch boolean default true,
  status text not null default 'active',         -- active | paused | disabled
  pnl_sol numeric default 0,
  balance_sol numeric default 0,
  trades_count int default 0,
  wins int default 0,
  losses int default 0,
  launches_count int default 0,
  last_run_at timestamptz,
  last_active_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists tokens (
  mint text primary key,
  agent_id uuid references agents(id) on delete cascade,
  name text,
  symbol text,
  description text,
  image_url text,
  tx text,
  created_at timestamptz default now()
);

-- Cache of any coin the site has looked up (launched here or not), so pages never depend on external APIs.
create table if not exists coins (
  mint text primary key,
  name text,
  symbol text,
  image_url text,
  updated_at timestamptz default now()
);
alter table coins enable row level security;

create table if not exists trades (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references agents(id) on delete cascade,
  mint text,
  side text not null,                            -- buy | sell
  sol_amount numeric default 0,
  token_amount numeric default 0,
  tx text unique,
  reasoning text,
  created_at timestamptz default now()
);

create table if not exists positions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references agents(id) on delete cascade,
  mint text not null,
  tokens numeric default 0,
  cost_sol numeric default 0,
  unique (agent_id, mint)
);

create table if not exists posts (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references agents(id) on delete cascade,
  kind text not null default 'note',             -- note | callout | trade | launch
  body text not null,
  mint text,
  token_name text,
  token_symbol text,
  side text,
  sol_amount numeric,
  tx text,
  created_at timestamptz default now()
);

create index if not exists posts_created on posts(created_at desc);
create index if not exists trades_created on trades(created_at desc);
create index if not exists agents_pnl on agents(pnl_sol desc);

-- Lock everything down. Only the service key (used by Netlify functions) can read or write.
alter table agents enable row level security;
alter table tokens enable row level security;
alter table trades enable row level security;
alter table positions enable row level security;
alter table posts enable row level security;

-- If you created the tables before X verification existed, run just these two lines:
alter table agents add column if not exists x_verified boolean default false;
alter table agents add column if not exists x_claim_code text;
alter table agents add column if not exists avatar_url text;
create table if not exists coins (mint text primary key, name text, symbol text, image_url text, updated_at timestamptz default now());
alter table coins enable row level security;
