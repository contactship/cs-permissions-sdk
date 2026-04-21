# @briansleonel/cs-permissions-sdk

NestJS SDK for role-based permission guards, decorators, and interfaces. Provides a plug-and-play module to handle organization-level JWT validation and feature/action permission checks across your NestJS services.

---

## Installation

```bash
npm install @briansleonel/cs-permissions-sdk
```

> **Peer dependencies** — make sure your project has these installed:
> ```bash
> npm install @nestjs/common @nestjs/core @nestjs/jwt
> ```

---

## Setup

### 1. Register the module in `AppModule`

#### Synchronous

```typescript
import { CsPermissionsSdkModule } from '@briansleonel/cs-permissions-sdk';

@Module({
  imports: [
    CsPermissionsSdkModule.forRoot({
      jwtSecret: 'your-jwt-secret',
    }),
  ],
})
export class AppModule {}
```

#### Asynchronous (recommended — inject your config service)

```typescript
import { CsPermissionsSdkModule } from '@briansleonel/cs-permissions-sdk';
import { ConfigService } from '@nestjs/config';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    CsPermissionsSdkModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        jwtSecret: config.get<string>('JWT_SECRET_API_KEY')!,
      }),
    }),
  ],
})
export class AppModule {}
```

> The module is **global** — you only need to register it once in `AppModule`. All other modules will have access to the guards automatically.

---

## Usage in Controllers

Apply both guards and the permission decorator to your endpoints:

```typescript
import {
  OrganizationRoleGuard,
  PermissionGuard,
  RequirePermission,
  RoleFeatureEnum,
  RoleActionEnum,
  ORG_TOKEN_HEADER,
} from '@briansleonel/cs-permissions-sdk';

@Controller('contacts')
export class ContactController {

  @UseGuards(OrganizationRoleGuard, PermissionGuard)
  @RequirePermission({
    feature: RoleFeatureEnum.CONTACTS,
    action: RoleActionEnum.CREATE,
  })
  @ApiHeader({
    name: ORG_TOKEN_HEADER,
    description: 'Organization permission token',
    required: true,
  })
  @Post()
  create() {
    // ...
  }

  @UseGuards(OrganizationRoleGuard, PermissionGuard)
  @RequirePermission({
    feature: RoleFeatureEnum.CONTACTS,
    action: RoleActionEnum.READ,
  })
  @Get()
  findAll() {
    // ...
  }
}
```

---

## Guards

### `OrganizationRoleGuard`

Validates the organization JWT token sent in the request header (`x-org-permissions`). It verifies the token signature and ensures the `user_id` in the token matches the authenticated user. On success, it attaches the decoded payload to `request.org_user_permissions`.

**Requires:** The header `x-org-permissions` with a valid signed JWT.

### `PermissionGuard`

Checks that the user's permissions (from `request.org_user_permissions`) include the feature and action required by the `@RequirePermission` decorator. If no decorator is present on the endpoint, the guard allows the request through.

**Requires:** `OrganizationRoleGuard` to run first (must be listed before it in `@UseGuards`).

---

## Decorator

### `@RequirePermission(permission: IRequiredPermission)`

Attaches the required permission metadata to a route handler or controller.

```typescript
@RequirePermission({
  feature: RoleFeatureEnum.USERS,
  action: RoleActionEnum.DELETE,
})
```

---

## Enums

### `RoleFeatureEnum`

Represents the available features in the system:

| Value | Description |
|---|---|
| `MESSAGES` | Messaging feature |
| `AGENTS` | Agents feature |
| `USERS` | User management |
| `CAMPAIGNS` | Campaign management |
| `CONTACTS` | Contact management |
| `OUTGOING_NUMBER` | Outgoing number config |
| `TEAM_MEMBER` | Team member management |
| `WIDGETS` | Widget management |
| `CALLS` | Call management |
| `ROLES` | Role management |

### `RoleActionEnum`

| Value | Description |
|---|---|
| `CREATE` | Create resources |
| `READ` | Read resources |
| `UPDATE` | Update resources |
| `DELETE` | Delete resources |

### `RoleScopeEnum`

| Value | Description |
|---|---|
| `ALL` | Access to all records |
| `ASSIGNED` | Access to assigned records |
| `UNASSIGNED` | Access to unassigned records |
| `OWN` | Access to own records only |

---

## Interfaces

### `IRequestWithUser<TUser>`

Extends Express `Request` with user and permission data. Generic so you can pass your own user type:

```typescript
import { IRequestWithUser } from '@briansleonel/cs-permissions-sdk';
import { IUserWithoutPassword } from './interfaces/user.interface';

const request = context
  .switchToHttp()
  .getRequest<IRequestWithUser<IUserWithoutPassword>>();

const user = request.user;                         // IUserWithoutPassword
const permissions = request.org_user_permissions;  // IRolePayload
```

### `IRolePayload`

The decoded payload from the organization JWT token:

```typescript
interface IRolePayload {
  user_id: string;
  organization_id: string;
  role_id: string;
  permissions: IPermissionPayload[];
}
```

### `IPermissionPayload`

A single permission entry:

```typescript
interface IPermissionPayload {
  feature: RoleFeatureEnum;
  action: RoleActionEnum;
  scope?: RoleScopeEnum;
}
```

### `IRequiredPermission`

Used with the `@RequirePermission` decorator:

```typescript
interface IRequiredPermission {
  feature: string;
  action: string;
  scope?: string | null;
}
```

### `IUserBase`

Minimum user shape expected by `IRequestWithUser`. Extend it with your own type:

```typescript
interface IUserBase {
  id: string;
  [key: string]: unknown;
}
```

---

## Constants

### `ORG_TOKEN_HEADER`

The header name used to send the organization JWT token:

```typescript
export const ORG_TOKEN_HEADER = 'x-org-permissions'; // 'x-org-permissions'
```

Use it with Swagger to document the required header:

```typescript
@ApiHeader({
  name: ORG_TOKEN_HEADER,
  description: 'Organization permission token',
  required: true,
})
```

---

## Full example

```typescript
import {
  OrganizationRoleGuard,
  PermissionGuard,
  RequirePermission,
  RoleFeatureEnum,
  RoleActionEnum,
  RoleScopeEnum,
  ORG_TOKEN_HEADER,
  IRequestWithUser,
} from '@briansleonel/cs-permissions-sdk';

@Controller('campaigns')
@UseGuards(OrganizationRoleGuard, PermissionGuard) // apply to all routes in controller
export class CampaignController {

  @RequirePermission({ feature: RoleFeatureEnum.CAMPAIGNS, action: RoleActionEnum.READ })
  @ApiHeader({ name: ORG_TOKEN_HEADER, required: true })
  @Get()
  findAll(@Req() req: IRequestWithUser) {
    const { organization_id } = req.org_user_permissions;
    // ...
  }

  @RequirePermission({ feature: RoleFeatureEnum.CAMPAIGNS, action: RoleActionEnum.CREATE })
  @ApiHeader({ name: ORG_TOKEN_HEADER, required: true })
  @Post()
  create() {
    // ...
  }

  @RequirePermission({ feature: RoleFeatureEnum.CAMPAIGNS, action: RoleActionEnum.DELETE })
  @ApiHeader({ name: ORG_TOKEN_HEADER, required: true })
  @Delete(':id')
  remove(@Param('id') id: string) {
    // ...
  }
}
```

---

## Exports summary

| Export | Type | Description |
|---|---|---|
| `CsPermissionsSdkModule` | Module | Main module — register with `forRoot` or `forRootAsync` |
| `OrganizationRoleGuard` | Guard | Validates the org JWT token |
| `PermissionGuard` | Guard | Checks feature/action permissions |
| `RequirePermission` | Decorator | Sets required permission on a route |
| `RoleFeatureEnum` | Enum | Available features |
| `RoleActionEnum` | Enum | Available actions |
| `RoleScopeEnum` | Enum | Available scopes |
| `ORG_TOKEN_HEADER` | Constant | Header name `x-org-permissions` |
| `IRequestWithUser` | Interface | Extended Express Request |
| `IRolePayload` | Interface | Decoded org JWT payload |
| `IPermissionPayload` | Interface | Single permission entry |
| `IRequiredPermission` | Interface | Decorator input shape |
| `IUserBase` | Interface | Minimum user shape |
