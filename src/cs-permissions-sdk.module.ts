import { RedisModule } from "@nestjs-modules/ioredis";
import { HttpModule } from "@nestjs/axios";
import { DynamicModule, Global, Module, Provider } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import {
  CS_PERMISSIONS_SDK_OPTIONS,
  PERMISSION_CACHE_TTL_TOKEN,
  PERMISSION_GATEWAY_URL_TOKEN,
  PERMISSION_JWT_SECRET_TOKEN,
} from "./constants/sdk-tokens.constant";
import { OrganizationRoleGuard } from "./guards/organization-role.guard";
import { PermissionGuard } from "./guards/permission.guard";
import { GatewayPermissionsClient } from "./services/gateway-permissions.client";
import { OrganizationPermissionsService } from "./services/organization-permissions.service";
import { MAX_PERMISSION_CACHE_TTL_SECONDS } from "./utils/permission-cache.helpers";

export interface CsPermissionsSdkOptions {
  redisUrl: string;
  gatewayUrl: string;
  /**
   * Seconds each cached user role and role permission set lives in this
   * service's Redis: the longest a change takes to reach this service when
   * nobody invalidates it (a seed, a manual fix, a lost notification).
   * Required on purpose, because a copy without an expiry is served forever.
   * A whole number between 1 and `MAX_PERMISSION_CACHE_TTL_SECONDS`.
   */
  cacheTtlSeconds: number;
  /**
   * @deprecated No longer used by the SDK after v1.1.0. Permissions are now
   * resolved from a granular Redis cache instead of a JWT. The option is kept
   * for backwards compatibility — passing it is harmless and ignored.
   */
  jwtSecret?: string;
}

export interface CsPermissionsSdkAsyncOptions {
  useFactory: (
    ...args: any[]
  ) => Promise<CsPermissionsSdkOptions> | CsPermissionsSdkOptions;
  inject?: any[];
  imports?: any[];
}

@Global()
@Module({})
export class CsPermissionsSdkModule {
  static forRoot(options: CsPermissionsSdkOptions): DynamicModule {
    const optionsProvider: Provider = {
      provide: CS_PERMISSIONS_SDK_OPTIONS,
      useValue: options,
    };

    return {
      module: CsPermissionsSdkModule,
      global: true,
      imports: [
        JwtModule.register({}),
        HttpModule.register({}),
        RedisModule.forRoot({
          type: "single",
          url: options.redisUrl,
        }),
      ],
      providers: [
        optionsProvider,
        ...this.buildDerivedProviders(),
        GatewayPermissionsClient,
        OrganizationPermissionsService,
        OrganizationRoleGuard,
        PermissionGuard,
      ],
      exports: [
        OrganizationRoleGuard,
        PermissionGuard,
        OrganizationPermissionsService,
        GatewayPermissionsClient,
        PERMISSION_JWT_SECRET_TOKEN,
        PERMISSION_GATEWAY_URL_TOKEN,
        PERMISSION_CACHE_TTL_TOKEN,
        JwtModule,
      ],
    };
  }

  static forRootAsync(
    asyncOptions: CsPermissionsSdkAsyncOptions,
  ): DynamicModule {
    const inject = asyncOptions.inject ?? [];
    const extraImports = asyncOptions.imports ?? [];

    const optionsProvider: Provider = {
      provide: CS_PERMISSIONS_SDK_OPTIONS,
      useFactory: asyncOptions.useFactory,
      inject,
    };

    return {
      module: CsPermissionsSdkModule,
      global: true,
      imports: [
        JwtModule.register({}),
        HttpModule.register({}),
        RedisModule.forRootAsync({
          inject,
          imports: extraImports,
          useFactory: async (...args: any[]) => {
            const opts = await asyncOptions.useFactory(...args);
            return {
              type: "single",
              url: opts.redisUrl,
            };
          },
        }),
        ...extraImports,
      ],
      providers: [
        optionsProvider,
        ...this.buildDerivedProviders(),
        GatewayPermissionsClient,
        OrganizationPermissionsService,
        OrganizationRoleGuard,
        PermissionGuard,
      ],
      exports: [
        OrganizationRoleGuard,
        PermissionGuard,
        OrganizationPermissionsService,
        GatewayPermissionsClient,
        PERMISSION_JWT_SECRET_TOKEN,
        PERMISSION_GATEWAY_URL_TOKEN,
        PERMISSION_CACHE_TTL_TOKEN,
        JwtModule,
      ],
    };
  }

  private static buildDerivedProviders(): Provider[] {
    return [
      {
        provide: PERMISSION_JWT_SECRET_TOKEN,
        useFactory: (opts: CsPermissionsSdkOptions) => opts.jwtSecret ?? "",
        inject: [CS_PERMISSIONS_SDK_OPTIONS],
      },
      {
        provide: PERMISSION_GATEWAY_URL_TOKEN,
        useFactory: (opts: CsPermissionsSdkOptions) => opts.gatewayUrl,
        inject: [CS_PERMISSIONS_SDK_OPTIONS],
      },
      {
        provide: PERMISSION_CACHE_TTL_TOKEN,
        useFactory: (opts: CsPermissionsSdkOptions) =>
          assertCacheTtlSeconds(opts.cacheTtlSeconds),
        inject: [CS_PERMISSIONS_SDK_OPTIONS],
      },
    ];
  }
}

/**
 * Runs while the app boots, so a missing or wrong TTL stops the service there
 * instead of caching permissions with no expiry. Options built from env vars
 * reach here as strings unless the consumer parses them, hence the type check.
 */
function assertCacheTtlSeconds(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_PERMISSION_CACHE_TTL_SECONDS
  ) {
    const received = typeof value === "string" ? `"${value}"` : String(value);
    throw new Error(
      `CsPermissionsSdkModule: cacheTtlSeconds must be a whole number of seconds between 1 and ${MAX_PERMISSION_CACHE_TTL_SECONDS}, received ${received}`,
    );
  }

  return value;
}
