# @briansleonel/cs-permissions-sdk

NestJS SDK that centralizes **organization-scoped role-based access control (RBAC)** for a microservices ecosystem. It transparently handles Redis caching and remote permission resolution against a central gateway, exposing a simple guard + decorator API to the consuming service.

The consuming service never queries the auth/role database directly. It only:
1. Sends the `x-organization-id` header.
2. Declares required permissions with `@RequirePermission(...)`.
3. Lets the SDK guards do the rest.

---

## Table of contents

- [Architecture](#architecture)
- [Installation](#installation)
- [Configuration](#configuration)
- [Required upstream contract](#required-upstream-contract)
- [Usage in controllers](#usage-in-controllers)
- [Public API](#public-api)
- [Internal services](#internal-services)
- [Caching strategy](#caching-strategy)
- [Cache invalidation](#cache-invalidation)
- [Injection tokens](#injection-tokens)
- [Migration from 1.0.x](#migration-from-10x)
- [Troubleshooting](#troubleshooting)

---

## Architecture

```
┌────────────┐  x-organization-id   ┌──────────────────────────────────────────────┐
│  Frontend  │ ───────────────────► │  Microservice (consumer)                     │
└────────────┘                      │                                              │
                                    │  ┌─────────────────────────────────────┐     │
                                    │  │ UserFromGatewayMiddleware           │     │
                                    │  └─────────────────────────────────────┘     │
                                    │                  │                           │
                                    │                  ▼                           │
                                    │  ┌─────────────────────────────────────┐     │
                                    │  │ OrganizationRoleGuard (SDK)         │     │
                                    │  │  └─► OrganizationPermissionsService │     │
                                    │  │        │                            │     │
                                    │  │        ├─► Redis GET                │     │
                                    │  │        │   org-roles:{org}:user:{u} │     │
                                    │  │        │   (TTL 1h)                 │     │
                                    │  │        │   miss → POST gateway      │─────┼──► /api/roles/internal/user-role
                                    │  │        │                            │     │
                                    │  │        └─► Redis GET                │     │
                                    │  │            role:{roleId}:permissions│     │
                                    │  │            (TTL 24h)                │     │
                                    │  │            miss → GET gateway       │─────┼──► /api/roles/internal/permissions/:roleId
                                    │  └─────────────────────────────────────┘     │
                                    │                  │                           │
                                    │                  ▼                           │
                                    │  ┌─────────────────────────────────────┐     │
                                    │  │ PermissionGuard (SDK)               │     │
                                    │  │   reads request.org_user_permissions│     │
                                    │  │   matches @RequirePermission metas  │     │
                                    │  └─────────────────────────────────────┘     │
                                    │                  │                           │
                                    │                  ▼                           │
                                    │             Controller                       │
                                    └──────────────────────────────────────────────┘
```

**Responsibilities**

| Layer | Owns |
|---|---|
| Gateway (external) | Database access, role/permission computation, cache invalidation on mutations |
| SDK | Two-tier Redis cache, header parsing, request enrichment, permission matching |
| Consumer service | Business logic, controllers, declaring required permissions |

The SDK **never** touches the auth/roles database. All resolution is delegated to the gateway over HTTP, and results are cached in Redis to avoid hitting the gateway on every request.

> **Why two cache keys instead of a single JWT?** Granular invalidation. When a role's permissions change, the gateway just `DEL`s `role:{roleId}:permissions` and **all users with that role** see the change immediately on their next request — no per-user token reissue, no JWT decode cost on every request.

---

## Installation

```bash
npm install @briansleonel/cs-permissions-sdk
```

### Peer dependencies

The SDK declares the following peer dependencies — your service must install them:

```bash
npm install \
  @nestjs/common @nestjs/core \
  @nestjs/axios axios rxjs \
  @nestjs-modules/ioredis ioredis
```

| Package | Why |
|---|---|
| `@nestjs/common`, `@nestjs/core` | NestJS runtime |
| `@nestjs/axios`, `axios`, `rxjs` | HTTP client used by `GatewayPermissionsClient` |
| `@nestjs-modules/ioredis`, `ioredis` | Redis client for the permissions cache |
| `@nestjs/jwt` | _Optional_ — only needed if your service uses the deprecated `jwtSecret` option, otherwise you can skip it |

---

## Configuration

The SDK is registered **once** in your `AppModule` via `forRoot` or `forRootAsync`. It is a `@Global()` module, so all other modules in your service can use the guards without re-importing.

### Configuration shape

```typescript
interface CsPermissionsSdkOptions {
  redisUrl: string;    // ioredis connection string, e.g. redis://localhost:6379
  gatewayUrl: string;  // base URL of the gateway service (no trailing slash needed)
  jwtSecret?: string;  // @deprecated — kept for backwards compatibility, no longer used
}
```

### Async (recommended)

```typescript
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CsPermissionsSdkModule } from '@briansleonel/cs-permissions-sdk';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    CsPermissionsSdkModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        redisUrl:   config.get<string>('REDIS_URL') ?? '',
        gatewayUrl: config.get<string>('GATEWAY_URL') ?? '',
      }),
    }),
  ],
})
export class AppModule {}
```

### Sync

```typescript
CsPermissionsSdkModule.forRoot({
  redisUrl:   'redis://localhost:6379',
  gatewayUrl: 'https://gateway.internal',
}),
```

### Required environment variables (suggested)

| Var | Example | Purpose |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | Redis instance used for the permissions cache |
| `GATEWAY_URL` | `https://gateway.internal` | Base URL of the gateway HTTP service |

---

## Required upstream contract

For the SDK to work, two upstream components must be in place:

### 1. Authentication middleware (in your service)

A middleware running **before** the SDK guards must populate `request.user` with at least:

```typescript
request.user = { id: string, /* ...rest of your user shape */ };
```

In the existing ecosystem this is `UserFromGatewayMiddleware`. The SDK uses `request.user.id` to ask the gateway for that user's role inside the requested organization.

### 2. Gateway endpoints (the central service)

The SDK calls **two** endpoints on the gateway:

#### `POST {gatewayUrl}/api/roles/internal/user-role`

Returns the user's role inside the organization.

Request body:
```json
{
  "organization_id": "uuid",
  "user_id": "uuid"
}
```

Response body (either shape is supported — the SDK auto-unwraps `{ data: ... }`):
```json
{
  "user_id": "uuid",
  "organization_id": "uuid",
  "role_id": "uuid"
}
```

Or wrapped:
```json
{
  "statusCode": 200,
  "data": {
    "user_id": "uuid",
    "organization_id": "uuid",
    "role_id": "uuid"
  }
}
```

#### `GET {gatewayUrl}/api/roles/internal/permissions/:roleId`

Returns the array of permissions for the given role.

Response body:
```json
[
  { "feature": "contacts", "action": "read",   "scope": null },
  { "feature": "contacts", "action": "create", "scope": ["all"] }
]
```

Or wrapped:
```json
{
  "statusCode": 200,
  "data": [
    { "feature": "contacts", "action": "read", "scope": null }
  ]
}
```

The shape of each permission must conform to [`IPermissionPayload`](#ipermissionpayload).

---

## Usage in controllers

The SDK exposes two guards that are designed to run together, in this exact order:

```typescript
import {
  OrganizationRoleGuard,
  PermissionGuard,
  RequirePermission,
  RoleFeatureEnum,
  RoleActionEnum,
  ORG_ID_HEADER,
} from '@briansleonel/cs-permissions-sdk';

@Controller('contacts')
@UseGuards(OrganizationRoleGuard, PermissionGuard)
@ApiHeader({ name: ORG_ID_HEADER, required: true, description: 'Organization id' })
export class ContactController {
  @Post()
  @RequirePermission({ feature: RoleFeatureEnum.CONTACTS, action: RoleActionEnum.CREATE })
  create() { /* ... */ }

  @Get()
  @RequirePermission({ feature: RoleFeatureEnum.CONTACTS, action: RoleActionEnum.READ })
  findAll() { /* ... */ }
}
```

**Order matters:** `OrganizationRoleGuard` must run before `PermissionGuard`, because the latter depends on `request.org_user_permissions` set by the former.

The frontend only needs to send the `x-organization-id` header — the SDK does everything else.

### Reading the resolved payload from the request

After both guards pass, the request is enriched with the resolved permissions:

```typescript
import { IRequestWithUser } from '@briansleonel/cs-permissions-sdk';

@Get('me')
whoami(@Req() req: IRequestWithUser) {
  const orgId = req.organization_id;
  const role  = req.org_user_permissions?.role_id;
  const perms = req.org_user_permissions?.permissions ?? [];
  return { orgId, role, perms };
}
```

---

## Public API

### Guards

#### `OrganizationRoleGuard`

Reads the `x-organization-id` header and the authenticated `request.user.id`, then asks `OrganizationPermissionsService` for the resolved role payload (cached in Redis or fetched from the gateway). On success it sets:

- `request.org_user_permissions` → `IRolePayload`
- `request.organization_id` → `string`

Throws `UnauthorizedException` if:
- the header is missing,
- `request.user` is missing,
- the gateway is unreachable,
- the resolved payload doesn't match the request context.

#### `PermissionGuard`

Reads the `@RequirePermission(...)` metadata and matches it against `request.org_user_permissions.permissions`. If no decorator is present on the route, the guard allows the request through. Throws `ForbiddenException` if the user lacks the required permission.

### Decorators

#### `@RequirePermission(p: IRequiredPermission)`

Attaches required-permission metadata to a route handler or to an entire controller class.

```typescript
@RequirePermission({
  feature: RoleFeatureEnum.USERS,
  action:  RoleActionEnum.DELETE,
})
```

#### `@ActiveUser()`

Param decorator that returns `request.user` directly:

```typescript
@Get('me')
me(@ActiveUser() user: IUserWithoutPassword) {
  return user;
}
```

#### `@CurrentScope(opts?)`

Param decorator that returns the `scope[]` array for a specific `(feature, action)` permission of the current user. Pairs with `@RequirePermission` to drive **row-level filtering** at the service layer (e.g. "admin sees all rows, viewer sees only own").

**Auto-inference (recommended):** when called with no arguments, it reads the `feature`/`action` from the `@RequirePermission` decorator on the same handler:

```typescript
@Get('/:orgId/integrations')
@RequirePermission({ feature: RoleFeatureEnum.INTEGRATIONS, action: RoleActionEnum.READ })
async listByOrg(
  @Param('orgId') orgId: string,
  @CurrentScope() scope: RoleScopeEnum[],
  @ActiveUser() user: IUserWithoutPassword,
) {
  const seesAll = hasFullAccess(scope);
  return this.integrationService.listByOrg(orgId, {
    filterByUserId: seesAll ? undefined : user.id,
    includeCreatedBy: seesAll,
  });
}
```

**Explicit override:** if you need a scope for a permission that's *not* the one declared in `@RequirePermission` (e.g. checking a secondary permission inline):

```typescript
@CurrentScope({ feature: RoleFeatureEnum.AGENTS, action: RoleActionEnum.READ })
agentsScope: RoleScopeEnum[],
```

Returns `[]` when the user doesn't have the permission or when neither auto-inference nor explicit options yield a `(feature, action)` pair. Use it together with the helpers below.

### Scope helpers

Plain functions (not NestJS providers) for reasoning about the scope array. Import and use them directly inside your services or controllers.

```typescript
import { hasFullAccess, canAccessOnlyOwn } from '@briansleonel/cs-permissions-sdk';

hasFullAccess(scope);     // true if scope includes RoleScopeEnum.ALL
canAccessOnlyOwn(scope);  // true if scope includes OWN but NOT ALL
```

Both accept `RoleScopeEnum[] | null | undefined` and return a `boolean`, so they are safe to call on raw `scope` values without nullish-check boilerplate.

### Enums

#### `RoleFeatureEnum`

| Value |
|---|
| `MESSAGES` |
| `AGENTS` |
| `USERS` |
| `CAMPAIGNS` |
| `CONTACTS` |
| `OUTGOING_NUMBER` |
| `TEAM_MEMBER` |
| `WIDGETS` |
| `CALLS` |
| `ROLES` |

#### `RoleActionEnum`

| Value |
|---|
| `CREATE` |
| `READ` |
| `UPDATE` |
| `DELETE` |

#### `RoleScopeEnum`

| Value | Meaning |
|---|---|
| `ALL` | All records |
| `ASSIGNED` | Records assigned to the user |
| `UNASSIGNED` | Records not assigned to anyone |
| `OWN` | Records owned by the user |

### Interfaces

#### `IRolePayload`

The payload set on `request.org_user_permissions` after `OrganizationRoleGuard` runs.

```typescript
interface IRolePayload {
  user_id: string;
  organization_id: string;
  role_id: string;
  permissions: IPermissionPayload[];
}
```

#### `IUserRole`

The cached membership record (returned by the user-role gateway endpoint).

```typescript
interface IUserRole {
  user_id: string;
  organization_id: string;
  role_id: string;
}
```

#### `IPermissionPayload`

```typescript
interface IPermissionPayload {
  feature: RoleFeatureEnum;
  action: RoleActionEnum;
  scope?: RoleScopeEnum[] | null;
}
```

#### `IRequiredPermission`

Used by `@RequirePermission`.

```typescript
interface IRequiredPermission {
  feature: string;
  action: string;
  scope?: string | null;
}
```

#### `IRequestWithUser`

Express `Request` extended with the SDK's contributions:

```typescript
interface IRequestWithUser extends Request {
  user: IUserWithoutPassword;
  organization_id?: string;
  org_user_permissions?: IRolePayload;
}
```

### Constants

| Constant | Value | Purpose |
|---|---|---|
| `ORG_ID_HEADER` | `'x-organization-id'` | Header sent by the frontend identifying the active org |
| `ORG_TOKEN_HEADER` | `'x-org-permissions'` | Legacy header (kept for backwards-compat with older flows) |

---

## Internal services

These services are exported in case you need to use them outside the guards (custom middleware, background jobs, scripts). In day-to-day controller code you don't need them.

### `OrganizationPermissionsService`

```typescript
resolvePermissions(organizationId: string, userId: string): Promise<IRolePayload>
```

Resolves the role payload by combining the two-tier cache:

1. `org-roles:{orgId}:user:{userId}` → fetched once per hour, contains `{ user_id, organization_id, role_id }`.
2. `role:{roleId}:permissions` → fetched on demand, contains the array of permissions for that role.
3. Combines both into an `IRolePayload` and returns it.

### `GatewayPermissionsClient`

```typescript
fetchUserRole(organizationId: string, userId: string): Promise<IUserRole>
fetchRolePermissions(roleId: string): Promise<IPermissionPayload[]>
```

Performs the actual HTTP calls to the gateway. Auto-unwraps `{ statusCode, data }` response shapes. Throws `ServiceUnavailableException` on failure (the underlying URL, status, and response body are logged).

---

## Caching strategy

| Key | Value | TTL | Refreshed when |
|---|---|---|---|
| `org-roles:{orgId}:user:{userId}` | `IUserRole` JSON | 1 hour | Cache miss or gateway `DEL` |
| `role:{roleId}:permissions` | `IPermissionPayload[]` JSON | 24 hours | Cache miss or gateway `DEL` |

Properties of this design:

- **No JWT verification on every request.** The previous design encoded `IRolePayload` as a JWT and re-verified the signature on every call. Now it's plain JSON in Redis — faster, simpler, no shared secret needed at runtime.
- **Granular invalidation.** When a role's permissions change, the gateway invalidates one key (`role:{roleId}:permissions`) and **every user holding that role** sees the change on their next request.
- **TTLs are a safety net.** The 1h on `org-roles:...` covers the case where a user's role is reassigned. The 24h on `role:...:permissions` covers the case where an explicit invalidation is missed.

---

## Cache invalidation

The gateway is the source of truth, so it must `DEL` the affected keys whenever data changes. Recommended hooks:

| Mutation on the gateway | Keys to delete |
|---|---|
| Permissions of a role change | `role:{roleId}:permissions` |
| A role is deleted | `role:{roleId}:permissions` (and force re-fetch of all users using it) |
| User is reassigned to a different role in an organization | `org-roles:{orgId}:user:{userId}` |
| User is removed from an organization | `org-roles:{orgId}:user:{userId}` |
| User is added to a new organization | _(no action needed — first request will populate)_ |

```typescript
// gateway side, after mutating role permissions
await this.redisService.del(`role:${roleId}:permissions`);

// after mutating user-organization membership
await this.redisService.del(`org-roles:${organizationId}:user:${userId}`);
```

---

## Injection tokens

The SDK exports three injection tokens. **You typically don't need any of these** — they are public so the DI graph is debuggable and so advanced consumers can override providers if needed.

| Token | Resolves to | Notes |
|---|---|---|
| `CS_PERMISSIONS_SDK_OPTIONS` | `CsPermissionsSdkOptions` | The full options object as produced by your `useFactory`. Single source of truth. |
| `PERMISSION_GATEWAY_URL_TOKEN` | `string` | Derived from `options.gatewayUrl`. |
| `PERMISSION_JWT_SECRET_TOKEN` | `string` | _Deprecated._ Resolves to `options.jwtSecret ?? ''`. Kept for backwards compatibility. |

### Why `CS_PERMISSIONS_SDK_OPTIONS` exists

If `forRootAsync` registered every derived provider with its own copy of `useFactory`, NestJS would invoke that factory once per provider. Centralizing the result in `CS_PERMISSIONS_SDK_OPTIONS` ensures the factory runs **once**, and the rest of the providers read from that single value.

---

## Migration from 1.0.x

If you are upgrading from `1.0.x`, the change is a **drop-in upgrade** — no code changes required in your service. The SDK still:

- Accepts `jwtSecret` in the options (it's now ignored).
- Exports `JwtModule` and `PERMISSION_JWT_SECRET_TOKEN` (kept for back-compat).
- Sets `request.org_user_permissions` with the same `IRolePayload` shape.

What changed under the hood:

- Permissions are now resolved from a **two-tier Redis cache** instead of a JWT cached in Redis.
- The gateway now needs to expose two new internal endpoints:
  - `POST /api/roles/internal/user-role`
  - `GET /api/roles/internal/permissions/:roleId`
- The previous `/api/auth/internal/permissions-token` endpoint is **no longer called** by the SDK. You can remove it from the gateway once all services are upgraded.

You can safely drop `jwtSecret` from your `useFactory` whenever convenient:

```typescript
// before
useFactory: (config) => ({
  jwtSecret:  config.get('JWT_SECRET_API_KEY') ?? '',
  redisUrl:   config.get('REDIS_URL') ?? '',
  gatewayUrl: config.get('GATEWAY_URL') ?? '',
}),

// after
useFactory: (config) => ({
  redisUrl:   config.get('REDIS_URL') ?? '',
  gatewayUrl: config.get('GATEWAY_URL') ?? '',
}),
```

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `UnauthorizedException: Missing organization id header` | Frontend didn't send `x-organization-id`. |
| `UnauthorizedException: Authenticated user is missing` | Your auth/user middleware is not running before the guards, or didn't set `request.user.id`. |
| `UnauthorizedException: Resolved permissions do not match request context` | Gateway returned a `user_role` that doesn't match the requested `(orgId, userId)`. Likely a bug in the gateway. |
| `ServiceUnavailableException: Failed to fetch user role from gateway` | Gateway is down, unreachable, returning non-2xx, or the user does not belong to the organization. Check `GATEWAY_URL` and gateway logs (the SDK logs URL, status, and response body). |
| `ServiceUnavailableException: Failed to fetch role permissions from gateway` | Same as above, but for the permissions endpoint. Check that `roleId` is valid in the gateway. |
| Permission changes don't take effect | Cache key was not invalidated. Verify the gateway `DEL`s `role:{roleId}:permissions` after mutations. |
| Role reassignment doesn't take effect | Verify the gateway `DEL`s `org-roles:{orgId}:user:{userId}` after the change. Otherwise wait up to 1 hour for the TTL to expire. |
| Redis errors at boot (`ECONNREFUSED`) | Wrong `REDIS_URL`, or Redis is not running. |

### Manual cache invalidation (gateway side)

```typescript
// invalidate a role's permissions for everyone using it
await redis.del(`role:${roleId}:permissions`);

// invalidate a single user's role membership
await redis.del(`org-roles:${organizationId}:user:${userId}`);
```

---

## Versioning

The SDK follows SemVer. Breaking changes to the public API (guards, decorators, exported interfaces, configuration shape) bump the major version. Internal changes (cache strategy tuning, logger output, new endpoints) ship in minor/patch.

| Version | Notes |
|---|---|
| `2.1.x` | `@CurrentScope()` decorator + `hasFullAccess` / `canAccessOnlyOwn` helpers for row-level filtering at the service layer. |
| `2.0.x` | Two-tier Redis cache (`org-roles:*` + `role:*:permissions`). Removed `OrganizationTokenService`. `jwtSecret` deprecated. |
| `1.0.x` | JWT-based cache. Required `jwtSecret`. Single gateway endpoint `/api/auth/internal/permissions-token`. |

---

## License

MIT
