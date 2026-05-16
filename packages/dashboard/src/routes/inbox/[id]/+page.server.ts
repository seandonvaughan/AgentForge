import type { PageServerLoad } from './$types';
import type { InboxRowSSR, InboxKind, InboxStatus } from '../+page.server.js';

export type { InboxRowSSR, InboxKind, InboxStatus };

export interface InboxThreadDetail {
  parent: InboxRowSSR;
  replies: InboxRowSSR[];
  recipients: Array<{ recipient: string; status: InboxStatus; readAt: string | null }>;
}

interface InboxDetailResponseRaw {
  data: {
    message: {
      id: string;
      body: string;
      kind: InboxKind;
      sourceId: string | null;
      sourceType: string | null;
      threadId: string | null;
      createdAt: string;
    };
    recipients: Array<{
      messageId: string;
      recipient: string;
      status: InboxStatus;
      readAt: string | null;
    }>;
  };
}

interface InboxListResponseRaw {
  data: InboxRowSSR[];
}

/**
 * Builds the full thread view for a single inbox message: the parent row
 * plus every reply that points at it via `thread_id`. The replies are
 * loaded by listing the @user inbox and filtering client-side — v1 has no
 * thread-scoped list endpoint, but the volume is small enough that this is
 * fine for the Phase 2 reply composer UX.
 */
export const load: PageServerLoad = async ({ fetch, params }) => {
  const id = params.id;

  const detailRes = await fetch(`/api/v5/inbox/${encodeURIComponent(id)}`);
  if (!detailRes.ok) {
    return { error: `Failed to load inbox message: HTTP ${detailRes.status}` };
  }
  const detail = (await detailRes.json()) as InboxDetailResponseRaw;
  const parent: InboxRowSSR = {
    ...detail.data.message,
    status:
      detail.data.recipients.find((r) => r.recipient === '@user')?.status ?? 'unread',
    readAt:
      detail.data.recipients.find((r) => r.recipient === '@user')?.readAt ?? null,
  };

  let replies: InboxRowSSR[] = [];
  try {
    const listRes = await fetch('/api/v5/inbox?recipient=%40user&limit=500');
    if (listRes.ok) {
      const list = (await listRes.json()) as InboxListResponseRaw;
      replies = list.data.filter((m) => m.threadId === id);
      replies.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }
  } catch {
    /* best-effort */
  }

  return {
    thread: { parent, replies, recipients: detail.data.recipients },
  };
};
