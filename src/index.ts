/**
 * AgentForge — root compatibility shim.
 *
 * All concrete implementations live in the @agentforge/* packages.
 * This file is a thin re-export so that any remaining consumer that
 * imports from the root src/ entry point continues to resolve
 * against the canonical package.
 */
export * from '@agentforge/core';
