import { RedisModule } from "@nestjs-modules/ioredis";
import { HttpModule } from "@nestjs/axios";
import { DynamicModule, Global, Module, Provider } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import {
  CS_PERMISSIONS_SDK_OPTIONS,
  PERMISSION_GATEWAY_URL_TOKEN,
  PERMISSION_JWT_SECRET_TOKEN,
} from "./constants/sdk-tokens.constant";
import { OrganizationRoleGuard } from "./guards/organization-role.guard";
import { PermissionGuard } from "./guards/permission.guard";
import { GatewayPermissionsClient } from "./services/gateway-permissions.client";
import { OrganizationPermissionsService } from "./services/organization-permissions.service";

export interface CsPermissionsSdkOptions {
  redisUrl: string;
  gatewayUrl: string;
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
    ];
  }
}
