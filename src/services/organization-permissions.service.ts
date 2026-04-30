import { InjectRedis } from "@nestjs-modules/ioredis";
import { Injectable } from "@nestjs/common";
import Redis from "ioredis";
import { IPermissionPayload } from "../interfaces/permissions-payload.interface";
import { IRolePayload } from "../interfaces/role-payload.interface";
import { IUserRole } from "../interfaces/user-role.interface";
import { GatewayPermissionsClient } from "./gateway-permissions.client";

const USER_ROLE_TTL_SECONDS = 60 * 60;

@Injectable()
export class OrganizationPermissionsService {
  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly gatewayClient: GatewayPermissionsClient,
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

  private async getOrFetchUserRole(
    organizationId: string,
    userId: string,
  ): Promise<IUserRole> {
    const key = this.buildUserRoleKey(organizationId, userId);
    const cached = await this.redis.get(key);

    if (cached) {
      return JSON.parse(cached) as IUserRole;
    }

    const userRole = await this.gatewayClient.fetchUserRole(
      organizationId,
      userId,
    );
    /*
    await this.redis.set(
      key,
      JSON.stringify(userRole),
      "EX",
      USER_ROLE_TTL_SECONDS,
    );
    */
    return userRole;
  }

  private async getOrFetchRolePermissions(
    roleId: string,
  ): Promise<IPermissionPayload[]> {
    const key = this.buildRolePermissionsKey(roleId);
    const cached = await this.redis.get(key);

    if (cached) {
      return JSON.parse(cached) as IPermissionPayload[];
    }

    const permissions = await this.gatewayClient.fetchRolePermissions(roleId);
    /*
    await this.redis.set(
      key,
      JSON.stringify(permissions),
    );
    */
    return permissions;
  }

  private buildUserRoleKey(organizationId: string, userId: string): string {
    return `org-roles:${organizationId}:user:${userId}`;
  }

  private buildRolePermissionsKey(roleId: string): string {
    return `role:${roleId}:permissions`;
  }
}
