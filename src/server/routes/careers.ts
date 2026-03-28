/**
 * Careers API Route — v6.1 Agent Identity Hub
 *
 * Exposes agent career records, skill profiles, and hiring recommendations
 * from the SQLite database.
 */

import type { FastifyInstance } from "fastify";
import type { SqliteAdapter } from "../../db/index.js";

interface CareerRow {
  agent_id: string;
  hired_at: string;
  current_team: string;
  current_role: string;
  seniority: string;
  autonomy_tier: number;
  tasks_completed: number;
  success_rate: number;
  avg_task_duration: number;
  peer_review_score: number;
  updated_at: string;
}

interface SkillRow {
  agent_id: string;
  skill_name: string;
  level: number;
  exercise_count: number;
  success_rate: number;
  last_exercised: string | null;
  unlocked_capabilities: string | null;
}

interface HiringRow {
  id: string;
  team_id: string;
  requested_role: string;
  requested_seniority: string;
  requested_skills: string | null;
  justification: string | null;
  status: string;
  requested_by: string | null;
  decided_by: string | null;
  created_at: string;
  decided_at: string | null;
}

export async function careersRoutes(
  app: FastifyInstance,
  opts: { adapter: SqliteAdapter },
) {
  const agentDb = opts.adapter.getAgentDatabase();
  const db = agentDb.getDb();

  // GET /api/v1/careers — list all agent career records
  app.get("/api/v1/careers", async (_req, reply) => {
    try {
      const rows = db
        .prepare<[], CareerRow>("SELECT * FROM agent_careers ORDER BY updated_at DESC")
        .all();
      return reply.send({ data: rows, meta: { total: rows.length } });
    } catch {
      return reply.send({ data: [], meta: { total: 0 } });
    }
  });

  // GET /api/v1/careers/:agentId — get specific agent's career
  app.get<{ Params: { agentId: string } }>("/api/v1/careers/:agentId", async (req, reply) => {
    try {
      const career = db
        .prepare<[string], CareerRow>("SELECT * FROM agent_careers WHERE agent_id = ?")
        .get(req.params.agentId);

      if (!career) {
        return reply.status(404).send({ error: `Career not found for "${req.params.agentId}"` });
      }

      const skills = db
        .prepare<[string], SkillRow>("SELECT * FROM agent_skills WHERE agent_id = ? ORDER BY level DESC")
        .all(req.params.agentId);

      return reply.send({
        ...career,
        skills: skills.map((s: SkillRow) => ({
          ...s,
          unlocked_capabilities: s.unlocked_capabilities
            ? JSON.parse(s.unlocked_capabilities)
            : [],
        })),
      });
    } catch {
      return reply.status(500).send({ error: "Failed to fetch career data" });
    }
  });

  // GET /api/v1/careers/:agentId/skills — get agent's skill profile
  app.get<{ Params: { agentId: string } }>("/api/v1/careers/:agentId/skills", async (req, reply) => {
    try {
      const skills = db
        .prepare<[string], SkillRow>("SELECT * FROM agent_skills WHERE agent_id = ? ORDER BY level DESC")
        .all(req.params.agentId);

      return reply.send({
        agentId: req.params.agentId,
        skills: skills.map((s: SkillRow) => ({
          ...s,
          unlocked_capabilities: s.unlocked_capabilities
            ? JSON.parse(s.unlocked_capabilities)
            : [],
        })),
        total: skills.length,
      });
    } catch {
      return reply.send({ agentId: req.params.agentId, skills: [], total: 0 });
    }
  });

  // GET /api/v1/hiring-recommendations — list hiring recommendations
  app.get("/api/v1/hiring-recommendations", async (req, reply) => {
    try {
      const status = (req.query as { status?: string }).status;
      const rows = status
        ? db.prepare<[string], HiringRow>("SELECT * FROM hiring_recommendations WHERE status = ? ORDER BY created_at DESC").all(status)
        : db.prepare<[], HiringRow>("SELECT * FROM hiring_recommendations ORDER BY created_at DESC").all();

      return reply.send({
        data: rows.map((r: HiringRow) => ({
          ...r,
          requested_skills: r.requested_skills ? JSON.parse(r.requested_skills) : [],
        })),
        meta: { total: rows.length },
      });
    } catch {
      return reply.send({ data: [], meta: { total: 0 } });
    }
  });
}
