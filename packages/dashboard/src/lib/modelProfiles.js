const PROFILES = {
    opus: { modelId: 'gpt-5.5', effort: 'xhigh', tier: 'opus' },
    sonnet: { modelId: 'gpt-5.3-codex', effort: 'high', tier: 'sonnet' },
    haiku: { modelId: 'gpt-5.4-mini', effort: 'medium', tier: 'haiku' },
};
export function codexProfileFor(value, effort) {
    const raw = (value ?? '').toLowerCase();
    const normalizedEffort = (effort ?? '').toLowerCase();
    if (!raw && !normalizedEffort)
        return null;
    if (raw.includes('gpt-5.5') || raw.includes('opus') || normalizedEffort === 'xhigh') {
        return { ...PROFILES.opus, effort: effort ?? PROFILES.opus.effort };
    }
    if (raw.includes('gpt-5.4-mini') || raw.includes('haiku') || normalizedEffort === 'medium') {
        return { ...PROFILES.haiku, effort: effort ?? PROFILES.haiku.effort };
    }
    if (raw.includes('gpt-5.3-codex') || raw.includes('sonnet') || normalizedEffort === 'high') {
        return { ...PROFILES.sonnet, effort: effort ?? PROFILES.sonnet.effort };
    }
    return null;
}
export function codexProfileLabel(value, effort) {
    const profile = codexProfileFor(value, effort);
    if (profile)
        return `${profile.modelId} / ${profile.effort}`;
    if (value && effort)
        return `${value} / ${effort}`;
    return value ?? '—';
}
export function codexTierFor(value, effort) {
    return codexProfileFor(value, effort)?.tier ?? null;
}
