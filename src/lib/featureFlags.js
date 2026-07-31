const prisma = require('./prisma');
const logger = require('./logger');

// Flags are checked on hot paths (potentially every request to a gated
// route), so we cache resolved values briefly instead of hitting the DB
// every time. TTL is short enough that toggling a flag in production
// takes effect within seconds, not requiring a deploy or restart.
const CACHE_TTL_MS = 10 * 1000;

const globalCache = new Map();       // key -> { value, expiresAt }
const orgOverrideCache = new Map();  // `${orgId}:${key}` -> { value: boolean|undefined, expiresAt }

function getCached(cache, cacheKey) {
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) return hit;
  return null;
}

function setCached(cache, cacheKey, value) {
  cache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Resolves whether a flag is enabled, checking (in order):
 *   1. An explicit per-org override, if organisationId is given
 *   2. The flag's global default
 *   3. false, if the flag doesn't exist at all (fail closed — an unknown
 *      flag key is treated as "off", not an error, so a typo'd key
 *      degrades safely rather than crashing a request)
 */
async function isEnabled(flagKey, organisationId = null) {
  if (organisationId) {
    const overrideCacheKey = `${organisationId}:${flagKey}`;
    const cachedOverride = getCached(orgOverrideCache, overrideCacheKey);
    if (cachedOverride) {
      if (cachedOverride.value !== undefined) return cachedOverride.value;
      // fall through to global default below
    } else {
      const override = await prisma.organisationFeatureFlag.findUnique({
        where: { organisationId_flagKey: { organisationId, flagKey } },
        select: { enabled: true },
      });
      setCached(orgOverrideCache, overrideCacheKey, override ? override.enabled : undefined);
      if (override) return override.enabled;
    }
  }

  const cachedGlobal = getCached(globalCache, flagKey);
  if (cachedGlobal) return cachedGlobal.value ?? false;

  const flag = await prisma.featureFlag.findUnique({
    where: { key: flagKey },
    select: { enabled: true },
  });

  if (!flag) {
    logger.warn('Feature flag check on unknown key — defaulting to disabled', { flagKey });
  }

  const resolved = flag ? flag.enabled : false;
  setCached(globalCache, flagKey, resolved);
  return resolved;
}

/** Returns { key, description, enabled, globalDefault, isOverridden } for every flag,
 *  resolved for a specific org if organisationId is given. Used by the
 *  org-facing feature-flags list endpoint. */
async function listForOrganisation(organisationId) {
  const flags = await prisma.featureFlag.findMany({
    orderBy: { key: 'asc' },
    include: organisationId
      ? { organisationOverrides: { where: { organisationId } } }
      : undefined,
  });

  return flags.map((flag) => {
    const override = organisationId ? flag.organisationOverrides?.[0] : undefined;
    return {
      key:           flag.key,
      description:   flag.description,
      globalDefault: flag.enabled,
      enabled:       override ? override.enabled : flag.enabled,
      isOverridden:  Boolean(override),
    };
  });
}

/** Clears both caches. Exposed for tests only — production code should
 *  rely on the TTL rather than manual invalidation. */
function _clearCacheForTests() {
  globalCache.clear();
  orgOverrideCache.clear();
}

module.exports = { isEnabled, listForOrganisation, _clearCacheForTests };
