export {
  detectBossPage,
  detectBossPageBlock,
  findBossJobCardElement,
  normalizeBossDetailUrl,
  parseBossDetail,
  parseVisibleBossCards,
  sourceJobIdFromUrl,
  verifyDetailIdentity,
  verifyStrictDetailIdentity,
} from "./adapter.js";
export { bossSelectors } from "./selectors.js";
export type {
  BossCardElementMatch,
  BossCardMatchMethod,
  BossIdentitySignal,
  BossIdentitySignals,
  BossIdentityVerification,
  BossJobCard,
  BossJobDetail,
  BossJobIdentity,
  BossPageBlock,
  BossPageBlockReason,
  BossPageType,
  VerifyDetailIdentityInput,
} from "./types.js";
