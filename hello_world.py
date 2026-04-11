def hello_world(name: str = "World") -> str:
    """
    Simple Hello World function in Python

    Args:
        name: Optional name to greet (defaults to "World")

    Returns:
        Greeting message
    """
    return f"Hello, {name}!"

# Example usage
if __name__ == "__main__":
    print(hello_world())  # "Hello, World!"
    print(hello_world("AgentForge"))  # "Hello, AgentForge!"