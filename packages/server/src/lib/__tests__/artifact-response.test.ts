import { describe, expect, it, vi } from 'vitest';
import { sendArtifactNotFound } from '../artifact-response.js';

describe('sendArtifactNotFound', () => {
  it('returns a consistent 404 JSON body for missing cycle artifacts', () => {
    const reply = {
      status: vi.fn(function status(this: { send(payload: unknown): unknown }) {
        return this;
      }),
      send: vi.fn((payload: unknown) => {
        return payload;
      }),
    };

    const response = sendArtifactNotFound(reply, {
      cycleId: 'cycle-123',
      artifact: 'review-finding.jsonl',
    });

    expect(reply.status).toHaveBeenCalledWith(404);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'Artifact not found',
      cycleId: 'cycle-123',
      artifact: 'review-finding.jsonl',
    });
    expect(response).toEqual({
      error: 'Artifact not found',
      cycleId: 'cycle-123',
      artifact: 'review-finding.jsonl',
    });
  });
});
