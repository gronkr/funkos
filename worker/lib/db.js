import { createClient } from '@supabase/supabase-js';

export const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

export async function getState(key, fallback = null) {
  const { data } = await db.from('colony_state').select('value').eq('key', key).maybeSingle();
  return data ? data.value : fallback;
}

export async function setState(key, value) {
  await db.from('colony_state').upsert({ key, value });
}

export async function post(agentId, kind, body, extra = {}) {
  const { data, error } = await db
    .from('messages')
    .insert({ agent_id: agentId, kind, body, ...extra })
    .select('id')
    .single();
  if (error) console.error('post failed', error.message);
  return data?.id ?? null;
}

export async function aliveAgents() {
  const { data } = await db.from('agents').select('*').eq('alive', true);
  return data || [];
}
