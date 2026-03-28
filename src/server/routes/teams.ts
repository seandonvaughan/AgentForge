/**
 * Teams API Route — v6.1 Agent Identity Hub
 *
 * Exposes team structure and utilization from `.agentforge/config/teams.yaml`.
 */

import type { FastifyInstance } from "fastify";
import type { SqliteAdapter } from "../../db/index.js";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

import type { TeamUnit } from "../../types/lifecycle.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "../../../");

function loadTeams(): TeamUnit[] {
  // Try config/teams.yaml first
  const teamsPath = join(PROJECT_ROOT, ".agentforge", "config", "teams.yaml");
  if (existsSync(teamsPath)) {
    const raw = readFileSync(teamsPath, "utf-8");
    const parsed = yaml.load(raw);
    if (Array.isArray(parsed)) return parsed as TeamUnit[];
  }

  // Fallback: extract from team.yaml
  const teamYamlPath = join(PROJECT_ROOT, ".agentforge", "team.yaml");
  if (existsSync(teamYamlPath)) {
    const raw = readFileSync(teamYamlPath, "utf-8");
    const manifest = yaml.load(raw) as { team_units?: TeamUnit[] };
    return manifest.team_units ?? [];
  }

  return [];
}

export async function teamsRoutes(
  app: FastifyInstance,
  _opts: { adapter?: SqliteAdapter },
) {
  // GET /api/v1/teams — list all team units
  app.get("/api/v1/teams", async (_req, reply) => {
    const teams = loadTeams();
    return reply.send({ data: teams, meta: { total: teams.length } });
  });

  // GET /api/v1/teams/:teamId — get specific team
  app.get<{ Params: { teamId: string } }>("/api/v1/teams/:teamId", async (req, reply) => {
    const teams = loadTeams();
    const team = teams.find((t) => t.id === req.params.teamId);
    if (!team) {
      return reply.status(404).send({ error: `Team "${req.params.teamId}" not found` });
    }
    return reply.send(team);
  });
}
