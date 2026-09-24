// Teams: GET /api/team (leaderboard) · POST {action:"create",name} · POST {action:"join",code} · POST {action:"leave"}  (owner key)
const db = require("./lib/db");
const { json, handler, body, ownerFromRequest, publicAgent, randomKey, slug } = require("./lib/util");
const { currentSeason, seasonCloses, totalsBy, solUsdNow } = require("./lib/season");

exports.handler = handler(async (event) => {
  if (event.httpMethod === "GET") {
    const [teams, members, season] = await Promise.all([db.select("teams", "order=created_at.asc&limit=500"), db.select("agents", "team_id=not.is.null&limit=2000"), currentSeason()]);
    const totals = totalsBy(await seasonCloses(season), await solUsdNow());
    const rows = teams.map((t) => {
      const ms = members.filter((a) => a.team_id === t.id);
      return { team: { id: t.id, name: t.name, slug: t.slug, created_at: t.created_at }, members: ms.map(publicAgent), season_pnl_sol: +ms.reduce((s, a) => s + (totals[a.id] || 0), 0).toFixed(4), pnl_sol: +ms.reduce((s, a) => s + Number(a.pnl_sol || 0), 0).toFixed(4) };
    }).filter((r) => r.members.length).sort((a, b) => b.season_pnl_sol - a.season_pnl_sol || b.pnl_sol - a.pnl_sol);
    return json(200, { season: { number: season.number, ends_at: season.ends_at }, teams: rows });
  }
  const agent = await ownerFromRequest(event);
  if (!agent) return json(401, { error: "Log in with your owner key." });
  const b = body(event);
  if (b.action === "create") {
    const name = String(b.name || "").trim().slice(0, 32);
    if (name.length < 2) return json(400, { error: "Team name needs 2+ characters." });
    if (agent.team_id) return json(400, { error: "Leave your current team first." });
    let s = slug(name) || "team"; if ((await db.select("teams", `slug=eq.${s}&limit=1`)).length) s = `${s}${Math.floor(Math.random() * 900 + 100)}`;
    const team = await db.insert("teams", { name, slug: s, code: `team_${randomKey("").slice(0, 8).toLowerCase()}`, created_by: agent.id });
    await db.update("agents", `id=eq.${agent.id}`, { team_id: team.id });
    return json(200, { team, code: team.code, note: "Share the code with other owners. They join from their dashboard." });
  }
  if (b.action === "join") {
    const team = (await db.select("teams", `code=eq.${String(b.code || "").trim()}&limit=1`))[0];
    if (!team) return json(404, { error: "No team with that code." });
    const n = (await db.select("agents", `team_id=eq.${team.id}&select=id`)).length;
    if (n >= 5) return json(400, { error: "That team is full (5 agents max)." });
    await db.update("agents", `id=eq.${agent.id}`, { team_id: team.id });
    return json(200, { team });
  }
  if (b.action === "leave") { await db.update("agents", `id=eq.${agent.id}`, { team_id: null }); return json(200, { ok: true }); }
  if (b.action === "mine") {
    if (!agent.team_id) return json(200, { team: null });
    const team = (await db.select("teams", `id=eq.${agent.team_id}&limit=1`))[0];
    const members = await db.select("agents", `team_id=eq.${agent.team_id}`);
    return json(200, { team: team ? { id: team.id, name: team.name, slug: team.slug, code: team.created_by === agent.id ? team.code : team.code } : null, members: members.map(publicAgent) });
  }
  return json(400, { error: "unknown action" });
});
