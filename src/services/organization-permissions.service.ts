import { InjectRedis } from "@nestjs-modules/ioredis";
import { Inject, Injectable, Logger } from "@nestjs/common";
import Redis from "ioredis";
import { PERMISSION_CACHE_TTL_TOKEN } from "../constants/sdk-tokens.constant";
import { IPermissionPayload } from "../interfaces/permissions-payload.interface";
import { IRolePayload } from "../interfaces/role-payload.interface";
import { IUserRole } from "../interfaces/user-role.interface";
import {
  buildRolePermissionsCacheKey,
  buildUserRoleCacheKey,
} from "../utils/permission-cache.helpers";
import { GatewayPermissionsClient } from "./gateway-permissions.client";

/** What `TTL` answers for a key that exists but never expires. */
const NO_EXPIRY = -1;

@Injectable()
export class OrganizationPermissionsService {
  private readonly logger = new Logger(OrganizationPermissionsService.name);

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly gatewayClient: GatewayPermissionsClient,
    @Inject(PERMISSION_CACHE_TTL_TOKEN)
    private readonly cacheTtlSeconds: number,
  ) {}

  async resolvePermissions(
    organizationId: string,
    userId: string,
  ): Promise<IRolePayload> {
    const userRole = await this.getOrFetchUserRole(organizationId, userId);
    const permissions = await this.getOrFetchRolePermissions(userRole.role_id);

    return {
      user_id: userRole.user_id,
      organization_id: userRole.organization_id,
      role_id: userRole.role_id,
      permissions,
    };
  }

  /**
   * Drops this service's copy of a role's permissions, so the next request
   * reads them from the gateway instead of waiting for the TTL. Call it after
   * changing a role's permissions or deleting the role.
   */
  async invalidateRole(roleId: string): Promise<void> {
    await this.redis.del(buildRolePermissionsCacheKey(roleId));
  }

  /**
   * Drops this service's copy of a user's role in an organization. Call it
   * after reassigning the role or removing the user from the organization.
   */
  async invalidateUserRole(
    organizationId: string,
    userId: string,
  ): Promise<void> {
    await this.redis.del(buildUserRoleCacheKey(organizationId, userId));
  }

  private async getOrFetchUserRole(
    organizationId: string,
    userId: string,
  ): Promise<IUserRole> {
    const key = buildUserRoleCacheKey(organizationId, userId);
    const cached = await this.readCache<IUserRole>(key);

    if (cached) {
      return cached;
    }

    const userRole = await this.gatewayClient.fetchUserRole(
      organizationId,
      userId,
    );
    await this.writeCache(key, userRole);

    return userRole;
  }

  private async getOrFetchRolePermissions(
    roleId: string,
  ): Promise<IPermissionPayload[]> {
    const key = buildRolePermissionsCacheKey(roleId);
    const cached = await this.readCache<IPermissionPayload[]>(key);

    if (cached) {
      return cached;
    }

    const permissions = await this.gatewayClient.fetchRolePermissions(roleId);
    await this.writeCache(key, permissions);

    return permissions;
  }

  /**
   * A copy is trusted only if it expires within this service's TTL. One that
   * never expires was written before every write carried a TTL and nothing
   * would ever refresh it; one that outlives the TTL came from a writer with a
   * looser contract. Both are read as a miss, and the refetch rewrites them
   * with this service's TTL, so each one heals on its first read.
   */
  private async readCache<T>(key: string): Promise<T | null> {
    const results = await this.redis.pipeline().get(key).ttl(key).exec();

    if (!results) {
      return null;
    }

    const [[getError, value], [ttlError, ttl]] = results;

    if (getError) throw getError;
    if (ttlError) throw ttlError;

    if (typeof value !== "string" || !value) {
      return null;
    }

    if (ttl === NO_EXPIRY) {
      this.logger.warn(`Ignoring ${key}: it never expires, fetching it again`);
      return null;
    }

    if (typeof ttl === "number" && ttl > this.cacheTtlSeconds) {
      return null;
    }

    return JSON.parse(value) as T;
  }

  /**
   * The value is already resolved at this point, so a failed write is only
   * logged: not being able to cache a permission must not turn into denying it.
   */
  private async writeCache(key: string, value: unknown): Promise<void> {
    try {
      await this.redis.set(
        key,
        JSON.stringify(value),
        "EX",
        this.cacheTtlSeconds,
      );
    } catch (err) {
      this.logger.warn(`Could not cache ${key}: ${(err as Error).message}`);
    }
  }
}
