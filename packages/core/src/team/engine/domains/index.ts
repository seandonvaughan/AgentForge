/**
 * Domains barrel export for AgentForge.
 *
 * Re-exports the domain pack loader and activation system.
 */

export {
  loadDomainPack,
  loadAllDomains,
  getDefaultDomainsDir,
} from "./domain-loader.js";

export { activateDomains } from "./domain-activator.js";
