import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { error } from '@sveltejs/kit';
import yaml from 'js-yaml';
import { resolveDashboardCodexProfile } from '../codex-profile.server.js';
/** Walk up from CWD until we find a directory that contains .agentforge/agents/. */
function findProjectRoot() {
    let dir = process.cwd();
    for (let i = 0; i < 6; i++) {
        if (existsSync(join(dir, '.agentforge', 'agents')))
            return dir;
        const parent = join(dir, '..');
        if (parent === dir)
            break;
        dir = parent;
    }
    return process.cwd();
}
function asRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
function asStringArray(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}
export const load = ({ params }) => {
    const { id } = params;
    const root = findProjectRoot();
    const filePath = join(root, '.agentforge', 'agents', `${id}.yaml`);
    if (!existsSync(filePath)) {
        error(404, `Agent "${id}" not found`);
    }
    let parsed;
    try {
        parsed = asRecord(yaml.load(readFileSync(filePath, 'utf-8')));
    }
    catch {
        error(500, `Failed to parse agent "${id}"`);
    }
    const collab = asRecord(parsed['collaboration']);
    const modelRaw = typeof parsed['model'] === 'string' ? parsed['model'] : 'sonnet';
    const model = modelRaw === 'opus' || modelRaw === 'haiku' ? modelRaw : 'sonnet';
    const effort = typeof parsed['effort'] === 'string' ? parsed['effort'] : null;
    const agent = {
        agentId: id,
        name: typeof parsed['name'] === 'string' ? parsed['name'] : id,
        model,
        capabilityTier: model,
        modelProfile: resolveDashboardCodexProfile(root, model, effort),
        description: typeof parsed['description'] === 'string' ? parsed['description'].trim() : null,
        role: typeof parsed['role'] === 'string' ? parsed['role'] : null,
        effort,
        systemPrompt: typeof parsed['system_prompt'] === 'string' ? parsed['system_prompt'] : null,
        skills: asStringArray(parsed['skills']),
        version: typeof parsed['version'] === 'string' ? parsed['version'] : null,
        seniority: typeof parsed['seniority'] === 'string' ? parsed['seniority'] : null,
        layer: typeof parsed['layer'] === 'string' ? parsed['layer'] : null,
        reportsTo: typeof collab['reports_to'] === 'string' ? collab['reports_to'] : null,
        canDelegateTo: asStringArray(collab['can_delegate_to']),
    };
    return { agent };
};
