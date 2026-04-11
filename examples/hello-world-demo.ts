#!/usr/bin/env node

/**
 * Demo script showing the hello world functions in action
 * Run with: npx tsx examples/hello-world-demo.ts
 */

import { helloWorld, simpleHello, demoHelloWorld } from '../src/utils/index.js';

console.log('=== Hello World Demo ===\n');

// Basic usage
console.log('1. Simple hello:');
console.log(simpleHello());
console.log();

// With custom name
console.log('2. Custom greeting:');
console.log(helloWorld({ name: 'AgentForge' }));
console.log();

// With enthusiasm
console.log('3. Enthusiastic greeting:');
console.log(helloWorld({ name: 'Developer', enthusiastic: true }));
console.log();

// With timestamp
console.log('4. Timestamped greeting:');
console.log(helloWorld({ name: 'TypeScript', timestamp: true }));
console.log();

// All options combined
console.log('5. Full-featured greeting:');
console.log(helloWorld({
  name: 'Claude Code',
  enthusiastic: true,
  timestamp: true
}));
console.log();

// Using the demo function
console.log('6. Demo function output:');
demoHelloWorld();