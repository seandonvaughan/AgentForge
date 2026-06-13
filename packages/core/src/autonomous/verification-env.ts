const CYCLE_CONTROL_ENV_KEYS = [
  'AGENTFORGE_UNATTENDED',
] as const;

const SCOPED_VERIFICATION_ENV_KEYS = [
  'AGENTFORGE_CHANGED_FILES',
  'AUTONOMOUS_BASE_BRANCH',
] as const;

export function buildVerificationSubprocessEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    CI: '1',
    NO_COLOR: '1',
  };

  for (const key of SCOPED_VERIFICATION_ENV_KEYS) {
    delete env[key];
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) env[key] = value;
  }

  env.CI = '1';
  env.NO_COLOR = '1';

  for (const key of CYCLE_CONTROL_ENV_KEYS) {
    delete env[key];
  }

  return env;
}
