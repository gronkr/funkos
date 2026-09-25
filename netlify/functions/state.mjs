import { createClient } from '@supabase/supabase-js';

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

export default async () => {
  const [agents, launches, messages, next] = await Promise.all([
    db.from('agents').select('id,handle,name,species,persona,strategy,lessons,color,generation,parents,alive,born_at,died_at,cause_of_death,launches,total_volume,best_mc').order('born_at'),
    db.from('launches').select('id,agent_id,name,symbol,mint,narrative,reasoning,image_url,created_at,volume_usd,mc_usd,ath_mc_usd,score,debriefed').order('created_at', { ascending: false }).limit(200),
    db.from('messages').select('id,agent_id,kind,body,launch_id,reply_to,created_at').order('created_at', { ascending: false }).limit(200),
    db.from('colony_state').select('value').eq('key', 'next_launch_at').maybeSingle(),
  ]);
  const body = {
    config: {
      x: process.env.X_URL || 'https://x.com/swarmsfun',
      paused: process.env.KILL_SWITCH === '1',
    },
    next_launch_at: next.data?.value || null,
    agents: agents.data || [],
    launches: launches.data || [],
    messages: (messages.data || []).reverse(),
  };
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=5' },
  });
};
