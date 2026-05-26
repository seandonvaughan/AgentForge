const CYCLE_CONTROL_ENV_KEYS = [
  'AGENTFORGE_UNATTENDED',
] as const;

export function buildVerificationSubprocessEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    CI: '1',
    NO_COLOR: '1',
  };

  for (const key of CYCLE_CONTROL_ENV_KEYS) {
    delete env[key];
  }

  return env;
}
