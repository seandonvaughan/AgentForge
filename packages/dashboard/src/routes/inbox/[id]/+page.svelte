<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import type { PageData } from './$types';
  import type { InboxRowSSR, InboxKind, InboxThreadDetail } from './+page.server.js';
  import { Card, Badge, Btn } from '$lib/components/v2';

  let { data }: { data: PageData } = $props();

  type ReplyTarget = 'user' | 'agent';

  let thread: InboxThreadDetail | null = $state(data.thread ?? null);
  let loadError: string | null = $state(data.error ?? null);
  let replyBody = $state('');
  let replyTarget: ReplyTarget = $state('user');
  let agentRecipient = $state('');
  let sending = $state(false);
  let sendError: string | null = $state(null);
  let sseSource: EventSource | null = null;

  // Best-effort agent extraction from the parent's `sourceType` — if it
  // looks like an agent id (no spaces, no slash, not one of the well-known
  // system types) we suggest it as the reply target. The user can override.
  const SYSTEM_SOURCES = new Set(['cost-warning', 'gate-verdict', 'review-finding', 'system']);
  const suggestedAgent = $derived.by(() => {
    const src = thread?.parent.sourceType ?? '';
    if (!src) return '';
    if (SYSTEM_SOURCES.has(src)) return '';
    if (/[\s\/]/.test(src)) return '';
    return src;
  });

  // Keep agentRecipient in sync with the suggestion until the user types.
  let agentRecipientTouched = $state(false);
  $effect(() => {
    if (!agentRecipientTouched && suggestedAgent) {
      agentRecipient = suggestedAgent;
    }
  });

  function kindVariant(kind: InboxKind): 'info' | 'warning' | 'danger' {
    if (kind === 'info') return 'info';
    if (kind === 'warning') return 'warning';
    return 'danger';
  }

  function kindLabel(kind: InboxKind): string {
    if (kind === 'info') return 'INFO';
    if (kind === 'warning') return 'WARNING';
    return 'ACTION';
  }

  function fmtAbs(iso: string): string {
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  }

  async function refreshThread(): Promise<void> {
    if (!thread) return;
    if (browser && document.visibilityState === 'hidden') return;
    try {
      const id = thread.parent.id;
      const [detailRes, listRes] = await Promise.all([
        fetch(`/api/v5/inbox/${encodeURIComponent(id)}`),
        fetch('/api/v5/inbox?recipient=%40user&limit=500'),
      ]);
      if (!detailRes.ok) return;
      const detail = (await detailRes.json()) as {
        data: {
          message: InboxRowSSR;
          recipients: InboxThreadDetail['recipients'];
        };
      };
      const list = listRes.ok
        ? ((await listRes.json()) as { data: InboxRowSSR[] })
        : { data: [] };
      const replies = list.data
        .filter((m) => m.threadId === id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const userRec = detail.data.recipients.find((r) => r.recipient === '@user');
      const parent: InboxRowSSR = {
        ...detail.data.message,
        status: userRec?.status ?? 'unread',
        readAt: userRec?.readAt ?? null,
      };
      thread = { parent, replies, recipients: detail.data.recipients };
    } catch {
      /* silent — we'll try again on the next SSE event */
    }
  }

  function startSse(): void {
    if (!browser) return;
    try {
      const src = new EventSource('/api/v5/stream');
      sseSource = src;
      src.addEventListener('message', (msg: MessageEvent<string>) => {
        let parsed: { type?: string; payload?: { kind?: string; threadId?: string | null; id?: string } } | null = null;
        try { parsed = JSON.parse(msg.data); } catch { return; }
        if (!parsed || parsed.type !== 'comms_event') return;
        const payload = parsed.payload;
        if (!payload) return;
        if (payload.kind === 'inbox' && (payload.threadId === thread?.parent.id || payload.id === thread?.parent.id)) {
          void refreshThread();
        }
      });
    } catch {
      /* SSE unsupported */
    }
  }

  onMount(() => {
    if (thread && thread.parent.status === 'unread') {
      void fetch(
        `/api/v5/inbox/${encodeURIComponent(thread.parent.id)}/read?recipient=%40user`,
        { method: 'PATCH' },
      ).catch(() => undefined);
    }
    startSse();
  });

  onDestroy(() => {
    if (sseSource) {
      sseSource.close();
      sseSource = null;
    }
  });

  async function submitReply(): Promise<void> {
    if (!thread) return;
    const body = replyBody.trim();
    if (!body) {
      sendError = 'Reply body is required.';
      return;
    }
    sending = true;
    sendError = null;
    try {
      if (replyTarget === 'agent') {
        const to = agentRecipient.trim();
        if (!to) {
          sendError = 'Agent recipient is required for DM replies.';
          return;
        }
        const res = await fetch('/api/v5/dms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fromAgent: '@user',
            toAgent: to,
            body,
          }),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({ error: 'request failed' }))) as { error?: string };
          throw new Error(err.error ?? `HTTP ${res.status}`);
        }
      } else {
        // Inbox reply — threadId points back at the parent so the dashboard
        // can render the chain. Kind matches the parent's so the UI badges
        // stay consistent across the thread.
        const res = await fetch('/api/v5/inbox', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            body,
            kind: thread.parent.kind,
            threadId: thread.parent.id,
            sourceType: 'user-reply',
            sourceId: thread.parent.id,
            recipients: ['@user'],
          }),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({ error: 'request failed' }))) as { error?: string };
          throw new Error(err.error ?? `HTTP ${res.status}`);
        }
      }
      replyBody = '';
      await refreshThread();
    } catch (e) {
      sendError = e instanceof Error ? e.message : 'Failed to send reply';
    } finally {
      sending = false;
    }
  }

  function backToInbox(): void {
    void goto('/inbox');
  }
</script>

<div class="page">
  <div class="page-header">
    <div>
      <button class="back-link" onclick={backToInbox}>&larr; Inbox</button>
      <h1 class="page-title">Thread</h1>
    </div>
  </div>

  {#if loadError}
    <Card>
      <div class="state-center">
        <span style="font-size:22px;color:var(--af-danger)">&#9888;</span>
        <span style="font-size:12px;color:var(--af-danger);margin-top:6px">{loadError}</span>
      </div>
    </Card>
  {:else if !thread}
    <Card>
      <div class="state-center">Loading...</div>
    </Card>
  {:else}
    <Card>
      <div class="detail-header">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <Badge variant={kindVariant(thread.parent.kind)}>{kindLabel(thread.parent.kind)}</Badge>
          <span class="meta-tag font-mono">id: {thread.parent.id}</span>
        </div>
        <h2 class="detail-title">{thread.parent.sourceType ?? 'system'}</h2>
        <div class="detail-ts font-mono">{fmtAbs(thread.parent.createdAt)}</div>
      </div>
      <div class="detail-body">{thread.parent.body}</div>
      {#if thread.parent.sourceId}
        <div style="margin-top:14px">
          <span class="detail-source font-mono">source: {thread.parent.sourceId}</span>
        </div>
      {/if}
    </Card>

    <div class="replies-header">
      <span class="section-title">
        REPLIES · <span class="font-mono">{thread.replies.length}</span>
      </span>
    </div>

    {#each thread.replies as reply (reply.id)}
      <Card style="margin-left:24px">
        <div class="reply-header">
          <Badge variant={kindVariant(reply.kind)} style="font-size:9px">
            {kindLabel(reply.kind)}
          </Badge>
          <span class="reply-source">{reply.sourceType ?? 'reply'}</span>
          <span class="reply-ts font-mono">{fmtAbs(reply.createdAt)}</span>
        </div>
        <div class="reply-body">{reply.body}</div>
      </Card>
    {/each}

    <Card>
      <div class="composer-header">
        <span class="section-title">COMPOSE REPLY</span>
      </div>
      <div class="target-row">
        <label class="target-option">
          <input
            type="radio"
            name="reply-target"
            value="user"
            checked={replyTarget === 'user'}
            onchange={() => (replyTarget = 'user')}
          />
          <span>Post to inbox (<span class="font-mono">@user</span>)</span>
        </label>
        <label class="target-option" class:disabled={!suggestedAgent && !agentRecipient}>
          <input
            type="radio"
            name="reply-target"
            value="agent"
            checked={replyTarget === 'agent'}
            onchange={() => (replyTarget = 'agent')}
          />
          <span>Send as DM to agent</span>
        </label>
      </div>
      {#if replyTarget === 'agent'}
        <div class="agent-row">
          <label class="agent-label">
            <span class="agent-label-text">Agent id</span>
            <input
              class="agent-input font-mono"
              type="text"
              bind:value={agentRecipient}
              oninput={() => (agentRecipientTouched = true)}
              placeholder="e.g. architect"
            />
          </label>
          {#if agentRecipient}
            <div class="agent-hint">
              This reply will be delivered to <span class="font-mono">{agentRecipient}</span>
              on its next invocation (DM via prompt injection).
            </div>
          {/if}
        </div>
      {/if}
      <textarea
        class="composer-textarea"
        bind:value={replyBody}
        placeholder="Write your reply…"
        rows="4"
      ></textarea>
      {#if sendError}
        <div class="send-error">{sendError}</div>
      {/if}
      <div class="composer-footer">
        <Btn size="sm" disabled={sending || replyBody.trim().length === 0} onClick={submitReply}>
          {sending ? 'Sending…' : 'Send reply'}
        </Btn>
      </div>
    </Card>
  {/if}
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 20px 24px;
    max-width: 900px;
  }
  .page-header {
    display: flex;
    align-items: flex-start;
    gap: 16px;
    margin-bottom: 2px;
  }
  .back-link {
    background: none;
    border: none;
    color: var(--af-dim);
    font-size: 11px;
    cursor: pointer;
    padding: 0;
    font-family: inherit;
  }
  .back-link:hover {
    color: var(--af-text);
  }
  .page-title {
    margin: 4px 0 0;
    font-size: 20px;
    font-weight: 700;
    color: var(--af-text);
  }
  .meta-tag {
    font-size: 10px;
    color: var(--af-dim);
    word-break: break-all;
  }
  .detail-header {
    margin-bottom: 14px;
    padding-bottom: 14px;
    border-bottom: 1px solid var(--af-border);
  }
  .detail-title {
    margin: 0 0 6px;
    font-size: 16px;
    font-weight: 600;
    color: var(--af-text);
    line-height: 1.4;
  }
  .detail-ts {
    font-size: 11px;
    color: var(--af-dim);
  }
  .detail-body {
    font-size: 13px;
    color: var(--af-muted);
    line-height: 1.65;
    white-space: pre-wrap;
  }
  .detail-source {
    font-size: 11px;
    color: var(--af-dim);
    word-break: break-all;
  }
  .replies-header {
    padding: 0 4px;
  }
  .section-title {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--af-dim);
  }
  .reply-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  .reply-source {
    font-size: 11px;
    color: var(--af-muted);
  }
  .reply-ts {
    font-size: 10px;
    color: var(--af-dim);
    margin-left: auto;
  }
  .reply-body {
    font-size: 12px;
    color: var(--af-text);
    line-height: 1.55;
    white-space: pre-wrap;
  }
  .composer-header {
    margin-bottom: 10px;
  }
  .target-row {
    display: flex;
    gap: 18px;
    margin-bottom: 12px;
    flex-wrap: wrap;
  }
  .target-option {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--af-muted);
    cursor: pointer;
  }
  .target-option.disabled {
    opacity: 0.6;
  }
  .agent-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 12px;
  }
  .agent-label {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .agent-label-text {
    font-size: 11px;
    color: var(--af-dim);
  }
  .agent-input {
    flex: 1;
    padding: 6px 10px;
    background: var(--af-surface);
    border: 1px solid var(--af-border2);
    color: var(--af-text);
    border-radius: 4px;
    font-size: 12px;
  }
  .agent-input:focus {
    outline: none;
    border-color: var(--af-purple);
  }
  .agent-hint {
    font-size: 11px;
    color: var(--af-dim);
    line-height: 1.4;
  }
  .composer-textarea {
    width: 100%;
    padding: 10px 12px;
    background: var(--af-surface);
    border: 1px solid var(--af-border2);
    color: var(--af-text);
    border-radius: 6px;
    font-size: 13px;
    font-family: inherit;
    resize: vertical;
    min-height: 80px;
  }
  .composer-textarea:focus {
    outline: none;
    border-color: var(--af-purple);
  }
  .send-error {
    margin-top: 8px;
    font-size: 11px;
    color: var(--af-danger);
  }
  .composer-footer {
    display: flex;
    justify-content: flex-end;
    margin-top: 12px;
  }
  .state-center {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 60px 20px;
    text-align: center;
    color: var(--af-dim);
    font-size: 13px;
  }
  .font-mono {
    font-family: var(--af-font-mono);
    font-feature-settings: 'tnum' 1;
  }
</style>
