export type ArtifactNotFoundBody = {
  error: 'Artifact not found';
  cycleId: string;
  artifact: string;
};

type ArtifactNotFoundReply = {
  status(statusCode: number): {
    send(payload: ArtifactNotFoundBody): unknown;
  };
};

export function sendArtifactNotFound(
  reply: ArtifactNotFoundReply,
  input: { cycleId: string; artifact: string },
): unknown {
  return reply.status(404).send({
    error: 'Artifact not found',
    cycleId: input.cycleId,
    artifact: input.artifact,
  });
}
