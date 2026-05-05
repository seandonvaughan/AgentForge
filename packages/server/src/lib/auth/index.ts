/**
 * Barrel export for the AgentForge OAuth2 auth module.
 */

export type {
  OAuth2Config,
  OAuth2Mode,
  JwtAlgorithm,
  TokenPayload,
  AuthResult,
} from "./types.js";

export {
  extractBearerToken,
  validateJwt,
  introspectToken,
  validateToken,
} from "./oauth2-validator.js";

export {
  registerOAuth2Hook,
  oauth2Plugin,
  isExcluded,
} from "./plugin.js";

export type {
  OAuth2PluginOptions,
  AuthContext,
} from "./plugin.js";
