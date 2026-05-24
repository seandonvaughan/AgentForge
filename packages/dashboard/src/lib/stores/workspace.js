// packages/dashboard/src/lib/stores/workspace.ts
//
// v6.6.0 Agent B — global workspace selection store.
//
// The currently-selected workspace id is persisted in localStorage so it
// survives page reloads. Most cycles API fetches read this store and
// append `?workspaceId={id}` to the URL when set.
import { writable, get } from 'svelte/store';
const STORAGE_KEY = 'agentforge:current-workspace-id';
function readStored() {
    if (typeof localStorage === 'undefined')
        return null;
    try {
        return localStorage.getItem(STORAGE_KEY);
    }
    catch {
        return null;
    }
}
function writeStored(id) {
    if (typeof localStorage === 'undefined')
        return;
    try {
        if (id === null)
            localStorage.removeItem(STORAGE_KEY);
        else
            localStorage.setItem(STORAGE_KEY, id);
    }
    catch {
        /* ignore */
    }
}
/** Currently-selected workspace id, or null when no workspace is selected
 * (cycles API calls then fall back to the server's launch cwd). */
export const currentWorkspaceId = writable(readStored());
currentWorkspaceId.subscribe((id) => writeStored(id));
/** All workspaces known to the server (loaded by loadWorkspaces). */
export const workspaces = writable([]);
/** Server-side default workspace id (returned by GET /api/v5/workspaces). */
export const defaultWorkspaceId = writable(null);
/** Append `?workspaceId={current}` (or `&workspaceId=`) to a URL when
 * a workspace is selected. Returns the URL unchanged otherwise. */
export function withWorkspace(url) {
    const id = get(currentWorkspaceId);
    if (!id)
        return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}workspaceId=${encodeURIComponent(id)}`;
}
/** Load the workspace list from the server and seed the stores. If no
 * workspace is currently selected and the server has a default, that
 * default is adopted. */
export async function loadWorkspaces() {
    try {
        const res = await fetch('/api/v5/workspaces');
        if (!res.ok)
            return;
        const json = await res.json();
        const list = (json?.data ?? []);
        workspaces.set(list);
        const def = (json?.defaultWorkspaceId ?? null);
        defaultWorkspaceId.set(def);
        const cur = get(currentWorkspaceId);
        if (!cur && def)
            currentWorkspaceId.set(def);
        // If the persisted selection no longer exists, clear it.
        if (cur && !list.some((w) => w.id === cur)) {
            currentWorkspaceId.set(def);
        }
    }
    catch {
        /* swallow — network errors are non-fatal */
    }
}
export function selectWorkspace(id) {
    currentWorkspaceId.set(id);
}
