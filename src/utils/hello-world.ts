/**
 * A simple hello world function demonstrating TypeScript fundamentals
 * in the AgentForge project structure.
 */

export interface GreetingOptions {
  name?: string;
  enthusiastic?: boolean;
  timestamp?: boolean;
}

/**
 * Generate a greeting message with optional customization
 *
 * @param options - Configuration options for the greeting
 * @returns A formatted greeting string
 */
export function helloWorld(options: GreetingOptions = {}): string {
  const {
    name = 'World',
    enthusiastic = false,
    timestamp = false
  } = options;

  let message = `Hello, ${name}`;

  if (enthusiastic) {
    message += '!';
  }

  if (timestamp) {
    const now = new Date().toISOString();
    message += ` (${now})`;
  }

  return message;
}

/**
 * A simple hello world function without options - the classic version
 */
export function simpleHello(): string {
  return 'Hello, World!';
}

/**
 * Demo function showing the hello world in action
 */
export function demoHelloWorld(): void {
  console.log(simpleHello());
  console.log(helloWorld({ name: 'AgentForge' }));
  console.log(helloWorld({ name: 'TypeScript', enthusiastic: true, timestamp: true }));
}