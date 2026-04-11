/**
 * Simple Hello World function in TypeScript
 * @param name - Optional name to greet
 * @returns Greeting message
 */
function helloWorld(name: string = "World"): string {
    return `Hello, ${name}!`;
}

// Class-based approach (OOP style)
class Greeter {
    private defaultName: string;

    constructor(defaultName: string = "World") {
        this.defaultName = defaultName;
    }

    greet(name?: string): string {
        return `Hello, ${name ?? this.defaultName}!`;
    }
}

// Example usage
console.log(helloWorld()); // "Hello, World!"
console.log(helloWorld("AgentForge")); // "Hello, AgentForge!"

const greeter = new Greeter("AgentForge");
console.log(greeter.greet()); // "Hello, AgentForge!"
console.log(greeter.greet("Claude")); // "Hello, Claude!"

export { helloWorld, Greeter };