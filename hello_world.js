/**
 * Simple Hello World function in JavaScript
 * @param {string} name - Optional name to greet
 * @returns {string} - Greeting message
 */
function helloWorld(name = "World") {
    return `Hello, ${name}!`;
}

// Example usage
console.log(helloWorld()); // "Hello, World!"
console.log(helloWorld("AgentForge")); // "Hello, AgentForge!"

module.exports = helloWorld;