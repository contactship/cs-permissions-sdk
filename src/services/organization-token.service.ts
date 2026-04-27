import { InjectRedis } from "@nestjs-modules/ioredis";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import Redis from "ioredis";
import { PERMISSION_JWT_SECRET_TOKEN } from "../constants/sdk-tokens.constant";
import { IRolePayload } from "../interfaces/role-payload.interface";
import { GatewayPermissionsClient } from "./gateway-permissions.client";

const TOKEN_TTL_SECONDS = 3600;
const TOKEN_REFRESH_THRESHOLD_SECONDS = 5 * 60;

@Injectable()
export class OrganizationTokenService {
  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly jwtService: JwtService,
    private readonly gatewayClient: GatewayPermissionsClient,
    @Inject(PERMISSION_JWT_SECRET_TOKEN) private readonly jwtSecret: string,
  ) {}

  async getOrRequestToken(
    organizationId: string,
    userId: string,
  ): Promise<IRolePayload> {
    const key = this.buildKey(organizationId, userId);
    const cached = await this.redis.get(key);

    if (cached) {
      const ttl = await this.redis.ttl(key);
      const shouldRefresh = ttl >= 0 && ttl <= TOKEN_REFRESH_THRESHOLD_SECONDS;

      const token = shouldRefresh
        ? await this.refreshToken(organizationId, userId, key)
        : cached;

      return this.decodeToken(token);
    }

    const fresh = await this.refreshToken(organizationId, userId, key);
    return this.decodeToken(fresh);
  }

  private async refreshToken(
    organizationId: string,
    userId: string,
    key: string,
  ): Promise<string> {
    const token = await this.gatewayClient.fetchToken(organizationId, userId);
    await this.redis.set(key, token, "EX", TOKEN_TTL_SECONDS);
    return token;
  }

  private decodeToken(token: string): IRolePayload {
    return this.jwtService.verify<IRolePayload>(token, {
      secret: this.jwtSecret,
    });
  }

  private buildKey(organizationId: string, userId: string): string {
    return `permissions-token:${organizationId}:${userId}`;
  }
}
