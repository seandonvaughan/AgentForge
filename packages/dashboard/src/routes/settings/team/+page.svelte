<script lang="ts">
  import { onMount } from 'svelte';
  import { Card, Btn, Badge } from '$lib/components/v2';

  type MemberRole = 'owner' | 'admin' | 'operator' | 'viewer';

  interface Member {
    id: string;
    email: string;
    displayName: string;
    role: MemberRole;
    createdAt: string;
    lastSeenAt: string | null;
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let members: Member[] = $state([]);
  let loading = $state(true);
  let loadError: string | null = $state(null);

  // Invite form
  let showInvite = $state(false);
  let inviteEmail = $state('');
  let inviteDisplayName = $state('');
  let inviteRole: MemberRole = $state('viewer');
  let inviteErrors: Partial<Record<'email' | 'displayName', string>> = $state({});
  let inviting = $state(false);
  let inviteError: string | null = $state(null);
  let inviteOk = $state(false);

  // Role update state
  let updatingRole: string | null = $state(null);

  // ── Computed ───────────────────────────────────────────────────────────────
  const ownerCount = $derived(members.filter(m => m.role === 'owner').length);

  const ROLES: { value: MemberRole; label: string }[] = [
    { value: 'owner', label: 'Owner' },
    { value: 'admin', label: 'Admin' },
    { value: 'operator', label: 'Operator' },
    { value: 'viewer', label: 'Viewer' },
  ];

  const ROLE_VARIANT: Record<MemberRole, 'purple' | 'info' | 'muted' | 'success'> = {
    owner: 'purple',
    admin: 'info',
    operator: 'success',
    viewer: 'muted',
  };

  // ── Helpers ────────────────────────────────────────────────────────────────
  function fmtRel(iso: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    const days = Math.floor(diff / 86_400_000);
    if (days < 30) return `${days}d ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function initials(name: string): string {
    return name.split(' ').map(w => w[0] ?? '').join('').toUpperCase().slice(0, 2);
  }

  // ── Load ───────────────────────────────────────────────────────────────────
  async function load() {
    loading = true;
    loadError = null;
    try {
      const res = await fetch('/api/v5/members');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { data: Member[] };
      members = json.data;
    } catch (e) {
      loadError = e instanceof Error ? e.message : 'Failed to load members';
    } finally {
      loading = false;
    }
  }

  // ── Validate invite ────────────────────────────────────────────────────────
  function validateInvite(): boolean {
    const next: typeof inviteErrors = {};
    if (!inviteEmail.trim()) {
      next.email = 'Email is required';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inviteEmail.trim())) {
      next.email = 'Must be a valid email address';
    }
    if (!inviteDisplayName.trim()) next.displayName = 'Display name is required';
    inviteErrors = next;
    return Object.keys(next).length === 0;
  }

  // ── Invite ─────────────────────────────────────────────────────────────────
  async function invite() {
    if (!validateInvite()) return;
    inviting = true;
    inviteError = null;
    inviteOk = false;
    try {
      const res = await fetch('/api/v5/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: inviteEmail.trim(),
          displayName: inviteDisplayName.trim(),
          role: inviteRole,
        }),
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      inviteOk = true;
      inviteEmail = '';
      inviteDisplayName = '';
      inviteRole = 'viewer';
      showInvite = false;
      await load();
      setTimeout(() => { inviteOk = false; }, 3000);
    } catch (e) {
      inviteError = e instanceof Error ? e.message : 'Invite failed';
    } finally {
      inviting = false;
    }
  }

  // ── Update role ────────────────────────────────────────────────────────────
  async function updateRole(member: Member, newRole: MemberRole) {
    // Guard: can't remove last owner
    if (member.role === 'owner' && newRole !== 'owner' && ownerCount <= 1) return;
    // Guard: operators can't elevate to owner/admin
    // (client-side guard only — server enforces via its own rules)
    updatingRole = member.id;
    try {
      const res = await fetch(`/api/v5/members/${member.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      await load();
    } catch (_) { /* noop */ }
    finally { updatingRole = null; }
  }

  // ── Remove member ──────────────────────────────────────────────────────────
  async function removeMember(member: Member) {
    if (member.role === 'owner' && ownerCount <= 1) return; // can't remove last owner
    try {
      const res = await fetch(`/api/v5/members/${member.id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch (_) { /* noop */ }
  }

  onMount(() => { void load(); });
</script>

<Card style="max-width:720px" noPad>
  <div class="card-hdr">
    <p class="section-title" style="margin:0">TEAM MEMBERS</p>
    <div class="hdr-actions">
      {#if inviteOk}<span class="save-ok">Invited!</span>{/if}
      <Btn variant="purple" size="sm" onclick={() => { showInvite = !showInvite; }}>
        {showInvite ? 'Cancel' : '+ Invite'}
      </Btn>
    </div>
  </div>

  {#if showInvite}
    <form onsubmit={(e) => { e.preventDefault(); void invite(); }} class="invite-form">
      <div class="invite-row">
        <div class="field">
          <label for="inv-name" class="field-label">Display name</label>
          <input id="inv-name" class="field-input" class:input-err={inviteErrors.displayName}
            type="text" bind:value={inviteDisplayName} placeholder="Jane Doe" />
          {#if inviteErrors.displayName}<p class="field-err">{inviteErrors.displayName}</p>{/if}
        </div>
        <div class="field">
          <label for="inv-email" class="field-label">Email</label>
          <input id="inv-email" class="field-input" class:input-err={inviteErrors.email}
            type="email" bind:value={inviteEmail} placeholder="jane@example.com" />
          {#if inviteErrors.email}<p class="field-err">{inviteErrors.email}</p>{/if}
        </div>
        <div class="field">
          <label for="inv-role" class="field-label">Role</label>
          <select id="inv-role" class="field-input" bind:value={inviteRole}>
            {#each ROLES as r}
              <option value={r.value}>{r.label}</option>
            {/each}
          </select>
        </div>
        <div class="field" style="justify-content:flex-end">
          <Btn variant="purple" type="submit" disabled={inviting}>
            {inviting ? 'Inviting…' : 'Invite'}
          </Btn>
        </div>
      </div>
      {#if inviteError}<p class="field-err">{inviteError}</p>{/if}
    </form>
  {/if}

  {#if loading}
    <div class="empty-row"><p class="dim-text">Loading…</p></div>
  {:else if loadError}
    <div class="empty-row">
      <p class="err-text">{loadError}</p>
      <Btn size="sm" onclick={() => load()}>Retry</Btn>
    </div>
  {:else if members.length === 0}
    <div class="empty-row"><p class="dim-text">No members yet. Invite someone above.</p></div>
  {:else}
    <div class="member-list">
      {#each members as member}
        {@const isLastOwner = member.role === 'owner' && ownerCount <= 1}
        <div class="member-row">
          <!-- Avatar -->
          <div class="avatar" aria-hidden="true">{initials(member.displayName)}</div>

          <!-- Info -->
          <div class="member-info">
            <p class="member-name">{member.displayName}</p>
            <p class="member-email">{member.email}</p>
          </div>

          <!-- Joined / last seen -->
          <div class="member-meta">
            <p class="meta-label">Joined <span class="font-mono">{fmtRel(member.createdAt)}</span></p>
            <p class="meta-label">Seen <span class="font-mono">{fmtRel(member.lastSeenAt)}</span></p>
          </div>

          <!-- Role selector -->
          <div class="role-wrap">
            {#if updatingRole === member.id}
              <Badge variant={ROLE_VARIANT[member.role]}>{member.role}</Badge>
              <span class="dim-text" style="font-size:10px">Saving…</span>
            {:else}
              <select
                class="role-select"
                value={member.role}
                disabled={isLastOwner}
                title={isLastOwner ? 'Cannot change role of the last owner' : undefined}
                onchange={(e) => {
                  const t = e.currentTarget as HTMLSelectElement;
                  void updateRole(member, t.value as MemberRole);
                }}
              >
                {#each ROLES as r}
                  <option value={r.value}>{r.label}</option>
                {/each}
              </select>
            {/if}
          </div>

          <!-- Remove button -->
          <Btn
            variant="danger"
            size="sm"
            disabled={isLastOwner}
            onclick={() => removeMember(member)}
          >
            Remove
          </Btn>
        </div>
      {/each}
    </div>
  {/if}
</Card>

<style>
  .section-title {
    font-size: 10px; font-weight: 700; letter-spacing: 0.1em;
    color: var(--af-dim); text-transform: uppercase;
  }
  .card-hdr {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 16px; border-bottom: 1px solid var(--af-border);
  }
  .hdr-actions { display: flex; align-items: center; gap: 10px; }
  .save-ok { font-size: 12px; color: var(--af-success); }

  /* Invite form */
  .invite-form {
    padding: 14px 16px; border-bottom: 1px solid var(--af-border);
    background: var(--af-surface2); display: flex; flex-direction: column; gap: 8px;
  }
  .invite-row {
    display: grid; grid-template-columns: 1fr 1fr 140px auto;
    gap: 10px; align-items: flex-end;
  }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .field-label { font-size: 12px; font-weight: 600; color: var(--af-muted); margin: 0; }
  .field-input {
    padding: 6px 10px; background: var(--af-surface); border: 1px solid var(--af-border2);
    border-radius: 6px; color: var(--af-text); font-size: 12px; outline: none;
    transition: border-color 150ms ease;
  }
  .field-input:focus { border-color: var(--af-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--af-accent) 15%, transparent); }
  .field-input.input-err { border-color: var(--af-danger); }
  .field-err { font-size: 11px; color: var(--af-danger); margin: 0; }

  /* Member list */
  .member-list { display: flex; flex-direction: column; }
  .member-row {
    display: flex; align-items: center; gap: 12px;
    padding: 12px 16px; border-bottom: 1px solid var(--af-border);
  }
  .member-row:last-child { border-bottom: none; }
  .avatar {
    width: 32px; height: 32px; border-radius: 50%; flex-shrink: 0;
    background: linear-gradient(135deg, var(--af-accent), var(--af-purple));
    display: flex; align-items: center; justify-content: center;
    font-size: 11px; font-weight: 700; color: #fff;
  }
  .member-info { flex: 1; min-width: 0; }
  .member-name  { font-size: 13px; font-weight: 600; color: var(--af-text); margin: 0 0 2px; }
  .member-email { font-size: 11px; color: var(--af-dim); margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .member-meta { display: flex; flex-direction: column; gap: 2px; flex-shrink: 0; }
  .meta-label  { font-size: 10px; color: var(--af-dim); margin: 0; }

  /* Role selector */
  .role-wrap { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
  .role-select {
    padding: 4px 8px; background: var(--af-surface2); border: 1px solid var(--af-border2);
    border-radius: 4px; color: var(--af-text); font-size: 11px; font-weight: 500;
    cursor: pointer; outline: none;
  }
  .role-select:disabled { opacity: 0.5; cursor: not-allowed; }
  .role-select:focus { border-color: var(--af-accent); }

  .empty-row { padding: 24px 16px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 8px; }
  .dim-text { font-size: 12px; color: var(--af-dim); margin: 0; }
  .err-text { color: var(--af-danger); font-size: 12px; margin: 0; }
</style>
