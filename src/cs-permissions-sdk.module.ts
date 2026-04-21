import { DynamicModule, Global, Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import {
  OrganizationRoleGuard,
  PERMISSION_JWT_SECRET_TOKEN,
} from "./guards/organization-role.guard";
import { PermissionGuard } from "./guards/permission.guard";

export interface CsPermissionsSdkOptions {
  jwtSecret: string;
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
    return {
      module: CsPermissionsSdkModule,
      imports: [JwtModule.register({})],
      providers: [
        {
          provide: PERMISSION_JWT_SECRET_TOKEN,
          useValue: options.jwtSecret,
        },
        OrganizationRoleGuard,
        PermissionGuard,
      ],
      exports: [OrganizationRoleGuard, PermissionGuard],
    };
  }

  static forRootAsync(
    asyncOptions: CsPermissionsSdkAsyncOptions,
  ): DynamicModule {
    return {
      module: CsPermissionsSdkModule,
      global: true,
      imports: [JwtModule.register({}), ...(asyncOptions.imports || [])],
      providers: [
        {
          provide: PERMISSION_JWT_SECRET_TOKEN,
          useFactory: async (...args: any[]) => {
            const options = await asyncOptions.useFactory(...args);
            return options.jwtSecret;
          },
          inject: asyncOptions.inject || [],
        },
        OrganizationRoleGuard,
        PermissionGuard,
      ],
      exports: [
        OrganizationRoleGuard,
        PermissionGuard,
        PERMISSION_JWT_SECRET_TOKEN,
      ],
    };
  }
}
