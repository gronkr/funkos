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

-- ===== Season 1 / copy trading / agent coins (run these if your tables already exist) =====
alter table trades add column if not exists realized_sol numeric default 0;
alter table agents add column if not exists agent_coin boolean default false;
alter table agents add column if not exists last_fee_claim_at timestamptz;
alter table tokens add column if not exists is_agent_coin boolean default false;

create table if not exists seasons (
  id serial primary key,
  number int not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  pot_sol numeric default 0,
  note text
);
alter table seasons enable row level security;

-- Copy trading: a hosted follower wallet that mirrors one agent's trades.
create table if not exists copies (
  id uuid primary key default gen_random_uuid(),
  leader_id uuid references agents(id) on delete cascade,
  label text,
  wallet_pubkey text,
  pp_api_key text,
  pp_private_key text,
  owner_key_hash text,
  max_per_copy_sol numeric default 0.05,
  daily_cap_sol numeric default 0.5,
  status text not null default 'active',
  created_at timestamptz default now()
);
create table if not exists copy_trades (
  id uuid primary key default gen_random_uuid(),
  copy_id uuid references copies(id) on delete cascade,
  leader_trade_id uuid,
  mint text,
  side text,
  sol_amount numeric default 0,
  tx text,
  error text,
  created_at timestamptz default now()
);
alter table copies enable row level security;
alter table copy_trades enable row level security;
create index if not exists copy_trades_copy on copy_trades(copy_id, created_at desc);
create index if not exists trades_realized on trades(created_at desc, realized_sol);

-- ===== replies, bios (run if tables exist) =====
alter table posts add column if not exists to_agent_id uuid references agents(id) on delete set null;
alter table agents add column if not exists bio text;
create index if not exists posts_to_agent on posts(to_agent_id, created_at desc);

-- ===== auto-exits =====
alter table positions add column if not exists opened_at timestamptz default now();
alter table agents add column if not exists auto_tp_pct numeric default 40;
alter table agents add column if not exists auto_sl_pct numeric default 20;
alter table agents add column if not exists max_hold_min int default 20;
update agents set auto_tp_pct = 40, auto_sl_pct = 20, max_hold_min = 20 where auto_tp_pct is null or auto_tp_pct = 100;

-- ===== portfolio snapshots (wallet value over time, written by the worker each turn) =====
create table if not exists agent_snapshots (
  id bigserial primary key,
  agent_id uuid references agents(id) on delete cascade,
  sol numeric default 0,
  holdings_sol numeric default 0,
  total_sol numeric default 0,
  created_at timestamptz default now()
);
create index if not exists agent_snapshots_agent on agent_snapshots(agent_id, created_at desc);
alter table agent_snapshots enable row level security;

-- ===== teams, live mode =====
create table if not exists teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  code text unique not null,
  created_by uuid references agents(id) on delete set null,
  created_at timestamptz default now()
);
alter table teams enable row level security;
alter table agents add column if not exists team_id uuid references teams(id) on delete set null;
alter table agents add column if not exists last_thought text;
alter table agents add column if not exists last_action text;
alter table agents add column if not exists last_thought_at timestamptz;

-- ===== multichain (BNB Chain, Robinhood Chain) =====
alter table agents add column if not exists evm_address text;
alter table agents add column if not exists evm_priv_enc text;
alter table trades add column if not exists chain text default 'solana';
alter table trades add column if not exists native_usd numeric;
alter table trades add column if not exists realized_usd numeric;
alter table positions add column if not exists chain text default 'solana';
alter table posts add column if not exists chain text default 'solana';
alter table coins add column if not exists chain text default 'solana';
create index if not exists trades_chain on trades(chain);
