/**
 * Builds the full thread view for a single inbox message: the parent row
 * plus every reply that points at it via `thread_id`. The replies are
 * loaded by listing the @user inbox and filtering client-side — v1 has no
 * thread-scoped list endpoint, but the volume is small enough that this is
 * fine for the Phase 2 reply composer UX.
 */
export const load = async ({ fetch, params }) => {
    const id = params.id;
    const detailRes = await fetch(`/api/v5/inbox/${encodeURIComponent(id)}`);
    if (!detailRes.ok) {
        return { error: `Failed to load inbox message: HTTP ${detailRes.status}` };
    }
    const detail = (await detailRes.json());
    const parent = {
        ...detail.data.message,
        status: detail.data.recipients.find((r) => r.recipient === '@user')?.status ?? 'unread',
        readAt: detail.data.recipients.find((r) => r.recipient === '@user')?.readAt ?? null,
    };
    let replies = [];
    try {
        const listRes = await fetch('/api/v5/inbox?recipient=%40user&limit=500');
        if (listRes.ok) {
            const list = (await listRes.json());
            replies = list.data.filter((m) => m.threadId === id);
            replies.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        }
    }
    catch {
        /* best-effort */
    }
    return {
        thread: { parent, replies, recipients: detail.data.recipients },
    };
};
