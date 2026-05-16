/**
 * autonomous-branches.ts — Production-quality autonomous branch management.
 * Fix 1 from v2 mock-data audit: promoted from dashboard-stubs.ts.
 */
import type { FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateId, nowIso } from '@agentforge/shared';
import { openAuditDb, appendAuditEntry } from './audit.js';
const execFileAsync = promisify(execFile);
export interface AutonomousBranch {
  name: string; cycle: string; lastCommitSha: string; lastCommitAt: string;
  ageMs: number; aheadOfMain: number; behindMain: number;
  status: 'open-pr' | 'merged' | 'active' | 'stale';
  prNumber: number | null; prUrl: string | null;
}
interface GhPr { headRefName: string; state: string; number: number; url: string; mergedAt: string | null; }
interface AutonomousBranchesRouteOpts { projectRoot?: string; }
const STALE_DAYS = 3;
const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1_000;
const EXEC_TIMEOUT_MS = 30_000;
const BRANCH_NAME_RE = /^autonomous\/[a-zA-Z0-9._\/-]+$/;
export function validateBranchName(name: string): string | null {
  if (!name.startsWith('autonomous/')) return 'Only autonomous/* branches may be deleted via this endpoint';
  if (!BRANCH_NAME_RE.test(name)) return 'Invalid branch name format';
  if (name.includes('..')) return 'Invalid branch name format';
  return null;
}
export async function listAutonomousBranches(cwd: string): Promise<AutonomousBranch[]> {
  let gitStdout: string;
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'for-each-ref', '--format=%(refname:short)\t%(objectname:short)\t%(creatordate:iso8601)', 'refs/heads/autonomous/'], { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS });
    gitStdout = stdout;
  } catch { return []; }
  const localBranches = gitStdout.trim().split('\n').filter(Boolean).map((line) => {
    const parts = line.split('\t');
    return { name: (parts[0] ?? '').trim(), sha: (parts[1] ?? '').trim(), lastCommitAt: parts.slice(2).join('\t').trim() };
  }).filter((b) => b.name.startsWith('autonomous/'));
  if (localBranches.length === 0) return [];
  const aheadBehindMap = new Map<string, { ahead: number; behind: number }>();
  await Promise.all(localBranches.map(async (b) => {
    try {
      const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-list', '--left-right', '--count', `main...${b.name}`], { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS });
      const [behindStr, aheadStr] = stdout.trim().split('\t');
      aheadBehindMap.set(b.name, { behind: parseInt(behindStr ?? '0', 10) || 0, ahead: parseInt(aheadStr ?? '0', 10) || 0 });
    } catch { aheadBehindMap.set(b.name, { ahead: 0, behind: 0 }); }
  }));
  const prsByBranch = new Map<string, GhPr[]>();
  try {
    const { stdout: ghOut } = await execFileAsync('gh', ['pr', 'list', '--state', 'all', '--limit', '100', '--json', 'headRefName,state,number,url,mergedAt'], { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS, cwd });
    const prs = JSON.parse(ghOut) as GhPr[];
    for (const pr of prs) {
      if (!pr.headRefName.startsWith('autonomous/')) continue;
      const existing = prsByBranch.get(pr.headRefName) ?? []; existing.push(pr); prsByBranch.set(pr.headRefName, existing);
    }
  } catch { /* gh unavailable */ }
  return localBranches.map(({ name, sha, lastCommitAt }) => {
    const cycle = name.replace(/^autonomous\//, '');
    const lastCommitDate = new Date(lastCommitAt);
    const ageMs = Date.now() - lastCommitDate.getTime();
    const { ahead: aheadOfMain, behind: behindMain } = aheadBehindMap.get(name) ?? { ahead: 0, behind: 0 };
    const prs = prsByBranch.get(name) ?? [];
    const openPr = prs.find((p) => p.state === 'OPEN');
    const mergedPr = prs.find((p) => p.state === 'MERGED' || p.mergedAt != null);
    let status: AutonomousBranch['status'], prNumber: number | null = null, prUrl: string | null = null;
    if (openPr) { status = 'open-pr'; prNumber = openPr.number; prUrl = openPr.url; }
    else if (mergedPr) { status = 'merged'; prNumber = mergedPr.number; prUrl = mergedPr.url; }
    else { status = ageMs > STALE_MS ? 'stale' : 'active'; const fp = prs.at(0); if (fp) { prNumber = fp.number; prUrl = fp.url; } }
    return { name, cycle, lastCommitSha: sha, lastCommitAt: lastCommitDate.toISOString(), ageMs, aheadOfMain, behindMain, status, prNumber, prUrl };
  });
}
export async function deleteAutonomousBranch(cwd: string, branchName: string, force: boolean): Promise<string> {
  try { await execFileAsync('git', ['-C', cwd, 'branch', force ? '-D' : '-d', branchName], { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }); }
  catch (err) { throw new Error(`Delete failed: ${err instanceof Error ? err.message.trim() : String(err)}`); }
  return branchName;
}
export async function autonomousBranchesRoutes(app: FastifyInstance, opts: AutonomousBranchesRouteOpts = {}): Promise<void> {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const db = openAuditDb(projectRoot);
  app.addHook('onClose', async () => { db.close(); });
  app.get('/api/v5/autonomous-branches', async (_req, reply) => {
    try { const data = await listAutonomousBranches(projectRoot); return reply.send({ data, meta: { total: data.length, updatedAt: nowIso() } }); }
    catch (err) { return reply.status(500).send({ error: String(err) }); }
  });
  app.delete('/api/v5/autonomous-branches/*', async (req: any, reply: any) => {
    const branchName = req.params['*'];
    const forceParam = (req.query as any)?.force;
    const force = forceParam === 'true' || forceParam === '1';
    const ve = validateBranchName(branchName);
    if (ve) return reply.status(400).send({ error: ve });
    if (!force) {
      try {
        const { stdout } = await execFileAsync('git', ['-C', projectRoot, 'branch', '--merged', 'main'], { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS });
        const mb = stdout.split('\n').map((l: string) => l.replace(/^\*?\s+/, '').trim()).filter(Boolean);
        if (!mb.includes(branchName)) return reply.status(409).send({ error: `Branch '${branchName}' has not been merged into main. Pass ?force=true to delete anyway.`, unmerged: true });
      } catch { /* cannot determine */ }
    }
    try { await deleteAutonomousBranch(projectRoot, branchName, force); }
    catch (err) { return reply.status(500).send({ error: String(err) }); }
    appendAuditEntry(db, { actor: 'api', action: 'autonomous-branch.delete', target: branchName, details: { force, requestId: generateId() } });
    return reply.send({ ok: true, deleted: branchName });
  });
}
