import { describe, it, expect } from 'vitest';
import { helloWorld, simpleHello, type GreetingOptions } from '../../src/utils/hello-world.js';

describe('Hello World Functions', () => {
  describe('simpleHello', () => {
    it('should return the classic hello world message', () => {
      expect(simpleHello()).toBe('Hello, World!');
    });
  });

  describe('helloWorld', () => {
    it('should return hello world with default options', () => {
      expect(helloWorld()).toBe('Hello, World');
    });

    it('should greet a specific name', () => {
      const options: GreetingOptions = { name: 'AgentForge' };
      expect(helloWorld(options)).toBe('Hello, AgentForge');
    });

    it('should add enthusiasm when requested', () => {
      const options: GreetingOptions = { name: 'TypeScript', enthusiastic: true };
      expect(helloWorld(options)).toBe('Hello, TypeScript!');
    });

    it('should include timestamp when requested', () => {
      const options: GreetingOptions = { name: 'Test', timestamp: true };
      const result = helloWorld(options);

      expect(result).toMatch(/^Hello, Test \(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\)$/);
    });

    it('should combine all options when provided', () => {
      const options: GreetingOptions = {
        name: 'Universe',
        enthusiastic: true,
        timestamp: true
      };
      const result = helloWorld(options);

      expect(result).toMatch(/^Hello, Universe! \(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\)$/);
    });
  });
});