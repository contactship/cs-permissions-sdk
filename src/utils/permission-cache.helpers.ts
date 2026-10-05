/**
 * Highest value accepted for `cacheTtlSeconds`. The cap catches a unit mistake
 * before it ships: `60000` reads like "a minute" but is almost 17 hours.
 */
export const MAX_PERMISSION_CACHE_TTL_SECONDS = 300;

export const buildUserRoleCacheKey = (
  organizationId: string,
  userId: string,
): string => `org-roles:${organizationId}:user:${userId}`;

export const buildRolePermissionsCacheKey = (roleId: string): string =>
  `role:${roleId}:permissions`;
