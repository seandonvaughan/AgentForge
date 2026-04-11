/**
 * A simple hello world function that demonstrates basic JavaScript syntax
 * and console output.
 *
 * @param {string} [name="World"] - The name to greet
 * @returns {string} The greeting message
 */
function helloWorld(name = "World") {
    const greeting = `Hello, ${name}!`;
    console.log(greeting);
    return greeting;
}

// Example usage
helloWorld(); // Outputs: "Hello, World!"
helloWorld("Claude"); // Outputs: "Hello, Claude!"
helloWorld("AgentForge"); // Outputs: "Hello, AgentForge!"

// Export for use in other modules
module.exports = helloWorld;