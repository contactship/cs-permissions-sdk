# @serranomatias/cs-permissions-sdk

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
- [Migration from 2.x](#migration-from-2x)
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
                                    │  │        │   (TTL cacheTtlSeconds)    │     │
                                    │  │        │   miss → POST gateway      │─────┼──► /api/roles/internal/user-role
                                    │  │        │                            │     │
                                    │  │        └─► Redis GET                │     │
                                    │  │            role:{roleId}:permissions│     │
                                    │  │            (TTL cacheTtlSeconds)    │     │
                                    │  │            miss → POST gateway      │─────┼──► /api/roles/internal/permissions/:roleId
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
| Gateway (external) | Database access, role/permission computation |
| SDK | Two-tier Redis cache with a mandatory TTL, header parsing, request enrichment, permission matching |
| Consumer service | Business logic, controllers, declaring required permissions, invalidating its own copy when it mutates roles |

The SDK **never** touches the auth/roles database. All resolution is delegated to the gateway over HTTP, and results are cached in the consumer's own Redis, with an expiry, to avoid hitting the gateway on every request.

> **Why two cache keys instead of a single JWT?** Granular invalidation. When a role's permissions change, deleting `role:{roleId}:permissions` makes **all users with that role** see the change on their next request — no per-user token reissue, no JWT decode cost on every request.

---

## Installation

```bash
npm install @serranomatias/cs-permissions-sdk
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
  redisUrl: string;         // ioredis connection string, e.g. redis://localhost:6379
  gatewayUrl: string;       // base URL of the gateway service (no trailing slash needed)
  cacheTtlSeconds: number;  // required — seconds each cached role / permission set lives, 1 to 300
  jwtSecret?: string;       // @deprecated — kept for backwards compatibility, no longer used
}
```

`cacheTtlSeconds` is the longest a change takes to reach your service when nobody invalidates it (a seed, a manual fix in the database, a lost notification). It has no default on purpose, and the module refuses to boot when it is missing, is not a whole number, or is outside `1..MAX_PERMISSION_CACHE_TTL_SECONDS` (300). The cap catches milliseconds passed by mistake. `60` is a sensible value. If you read it from an env var, parse it: a string is rejected too.

### Async (recommended)

```typescript
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CsPermissionsSdkModule } from '@serranomatias/cs-permissions-sdk';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    CsPermissionsSdkModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        redisUrl:        config.get<string>('REDIS_URL') ?? '',
        gatewayUrl:      config.get<string>('GATEWAY_URL') ?? '',
        cacheTtlSeconds: 60,
      }),
    }),
  ],
})
export class AppModule {}
```

### Sync

```typescript
CsPermissionsSdkModule.forRoot({
  redisUrl:        'redis://localhost:6379',
  gatewayUrl:      'https://gateway.internal',
  cacheTtlSeconds: 60,
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

#### `POST {gatewayUrl}/api/roles/internal/permissions/:roleId`

Returns the permissions for the given role.

Response body:
```json
{
  "role_id": "uuid",
  "permissions": [
    { "feature": "contacts", "action": "read",   "scope": null },
    { "feature": "contacts", "action": "create", "scope": ["all"] }
  ]
}
```

Or wrapped:
```json
{
  "statusCode": 200,
  "data": {
    "role_id": "uuid",
    "permissions": [
      { "feature": "contacts", "action": "read", "scope": null }
    ]
  }
}
```

The shape of each permission must conform to [`IPermissionPayload`](#ipermissionpayload).

---

## Usage in controllers

The SDK exposes two guards that are designed to run together, in this exact order:

> **⚠️ The guards must be applied with `@UseGuards(...)`.** The `@RequirePermission` decorator alone does **not** enforce anything — it only attaches metadata. The actual enforcement and the population of `request.org_user_permissions` happens inside `OrganizationRoleGuard` + `PermissionGuard`. Forgetting `@UseGuards` is the most common mistake when integrating the SDK: the endpoint will run anyway, `request.org_user_permissions` will be `undefined`, and `@CurrentScope()` will return `[]`. If you want a global setup so you don't have to repeat `@UseGuards` per controller, see [Global guards](#global-guards).

```typescript
import {
  OrganizationRoleGuard,
  PermissionGuard,
  RequirePermission,
  RoleFeatureEnum,
  RoleActionEnum,
  ORG_ID_HEADER,
} from '@serranomatias/cs-permissions-sdk';

@Controller('contacts')
@UseGuards(OrganizationRoleGuard, PermissionGuard)   // 👈 required — without this nothing is enforced
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

### Global guards

If you want every endpoint in your service protected automatically — without having to add `@UseGuards(OrganizationRoleGuard, PermissionGuard)` on every controller — register them globally in `AppModule`:

```typescript
import { APP_GUARD } from '@nestjs/core';

@Module({
  providers: [
    { provide: APP_GUARD, useClass: OrganizationRoleGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
})
export class AppModule {}
```

**Trade-off:** with global guards, the SDK runs on **every** route — including ones that should stay public (login, health, webhooks, etc.). You'd typically pair this with a `@Public()` skip decorator and a check inside the guards. For most services starting out, `@UseGuards` per controller is more explicit and easier to reason about — switch to global only when the repetition becomes noticeable.

### Bypassing the guards via a request flag

When a service has **multiple authentication methods** — typically a user bearer token *plus* an org-level api-key — the api-key path has no user attached and therefore no role/permissions to evaluate. The SDK supports this by short-circuiting both guards when an upstream guard sets `request.skip_permissions_check = true`.

The contract is intentionally simple: **the SDK does not know about your auth methods**. Your `AuthGuard` decides whether the current request should bypass and sets the flag; the SDK guards read it and return `true` immediately.

```typescript
// your service: src/guards/auth.guard.ts
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { IRequestWithUser } from '@serranomatias/cs-permissions-sdk';

@Injectable()
export class AuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<IRequestWithUser>();
    const apiKey  = request.headers['x-api-key'] as string | undefined;
    const bearer  = this.extractBearer(request.headers.authorization);

    if (apiKey) {
      const org = await this.validateApiKey(apiKey);
      if (!org) throw new UnauthorizedException('Invalid API key');
      request.skip_permissions_check = true;     // 👈 SDK guards will return true
      request.organization_id = org.id;
      return true;
    }

    if (bearer) {
      const user = await this.validateBearer(bearer);
      if (!user) throw new UnauthorizedException('Invalid token');
      request.user = user;                     // SDK guards will resolve permissions
      return true;
    }

    throw new UnauthorizedException('No credentials provided');
  }
}
```

Chain the guards in this order — your `AuthGuard` first, then the SDK guards:

```typescript
@UseGuards(AuthGuard, OrganizationRoleGuard, PermissionGuard)
@RequirePermission({ feature: RoleFeatureEnum.MESSAGES, action: RoleActionEnum.READ })
@Get(':threadId/timeline')
async getTimeline(...) { /* ... */ }
```

**What happens at runtime**

| Auth method | After `AuthGuard` | Inside `OrganizationRoleGuard` | Inside `PermissionGuard` |
|---|---|---|---|
| Bearer (user) | `request.user` set | Resolves role + permissions, populates `request.org_user_permissions` | Matches required permission |
| Api-key (org) | `request.skip_permissions_check = true` | Returns `true` immediately, no Redis/gateway calls | Returns `true` immediately |

> **Heads-up for the handler.** When the request was authenticated via api-key, `request.org_user_permissions` will be `undefined` inside the controller. If your handler reads `req.org_user_permissions?.permissions`, you need to handle that case explicitly — typically by treating api-key requests as if they had full scope (`scope: [ALL]`) or by returning an org-wide projection. This is intentional: an org-level api-key has no per-user role to derive scope from.

**Why a request flag instead of a config predicate?**

Putting the bypass logic in your `AuthGuard` (where authentication decisions belong) keeps the SDK agnostic of your auth implementation. If you add a new auth method later (`x-service-token`, mTLS, etc.), you only touch the `AuthGuard` — no SDK config change, no controller change.

### Reading the resolved payload from the request

After both guards pass, the request is enriched with the resolved permissions:

```typescript
import { IRequestWithUser } from '@serranomatias/cs-permissions-sdk';

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
- the gateway is unreachable and this service has no valid copy in its cache,
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

> **⚠️ Requires the guards to be applied.** `@CurrentScope()` reads from `request.org_user_permissions`, which is populated by `OrganizationRoleGuard`. You **must** apply `@UseGuards(OrganizationRoleGuard, PermissionGuard)` at the controller or method level (or register them globally — see [Global guards](#global-guards)). Without that, `@CurrentScope()` returns `[]` because `request.org_user_permissions` is `undefined`. The `@RequirePermission` decorator alone is just metadata — it does not enforce anything by itself.

**Auto-inference (recommended):** when called with no arguments, it reads the `feature`/`action` from the `@RequirePermission` decorator on the same handler:

```typescript
@Controller()
@UseGuards(OrganizationRoleGuard, PermissionGuard)   // 👈 required
export class IntegrationController {

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
}
```

**Explicit override:** if you need a scope for a permission that's *not* the one declared in `@RequirePermission` (e.g. checking a secondary permission inline):

```typescript
@CurrentScope({ feature: RoleFeatureEnum.AGENTS, action: RoleActionEnum.READ })
agentsScope: RoleScopeEnum[],
```

Returns `[]` when the user doesn't have the permission, when the guards weren't applied, or when neither auto-inference nor explicit options yield a `(feature, action)` pair. Use it together with the helpers below.

### Scope helpers

Plain functions (not NestJS providers) for reasoning about the scope array. Import and use them directly inside your services or controllers.

```typescript
import { hasFullAccess, canAccessOnlyOwn } from '@serranomatias/cs-permissions-sdk';

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
invalidateRole(roleId: string): Promise<void>
invalidateUserRole(organizationId: string, userId: string): Promise<void>
```

`resolvePermissions` resolves the role payload by combining the two-tier cache:

1. `org-roles:{orgId}:user:{userId}` → contains `{ user_id, organization_id, role_id }`.
2. `role:{roleId}:permissions` → contains the array of permissions for that role.
3. Combines both into an `IRolePayload` and returns it.

Each key is fetched from the gateway on a miss and stored for `cacheTtlSeconds`.

`invalidateRole` and `invalidateUserRole` delete this service's copy of a key, so the next request reads it from the gateway. See [Cache invalidation](#cache-invalidation).

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
| `org-roles:{orgId}:user:{userId}` | `IUserRole` JSON | `cacheTtlSeconds` | Expiry, cache miss or `invalidateUserRole` |
| `role:{roleId}:permissions` | `IPermissionPayload[]` JSON | `cacheTtlSeconds` | Expiry, cache miss or `invalidateRole` |

Use `buildUserRoleCacheKey` and `buildRolePermissionsCacheKey` instead of writing the key format by hand.

Properties of this design:

- **Each service keeps its own copy.** The SDK writes to the Redis passed in `redisUrl`. No other service needs to share it, and nothing outside the SDK needs to write these keys.
- **Correctness never depends on an invalidation arriving.** Every copy expires within `cacheTtlSeconds`, so a change made where nobody invalidates — a seed, a manual fix, a lost notification — reaches the service within that time.
- **Copies the SDK did not write are not trusted blindly.** A key with no expiry, or with an expiry longer than `cacheTtlSeconds`, is read as a miss. It is then rewritten with the SDK's TTL. This retires copies left behind by older writers on their first read.
- **A failed write does not deny the request.** The permissions were already resolved by the gateway, so the SDK logs the error and carries on.
- **No JWT verification on every request.** The previous design encoded `IRolePayload` as a JWT and re-verified the signature on every call. Now it's plain JSON in Redis — faster, simpler, no shared secret needed at runtime.

---

## Cache invalidation

Invalidation is the fast path; the TTL is what guarantees correctness. The service that writes the data deletes its own copy right after the write, then tells the other services. If that notification is lost, the other copies still expire within `cacheTtlSeconds`.

| Mutation | Call |
|---|---|
| Permissions of a role change | `invalidateRole(roleId)` |
| A role is deleted | `invalidateRole(roleId)` |
| User is reassigned to a different role in an organization | `invalidateUserRole(orgId, userId)` |
| User is removed from an organization | `invalidateUserRole(orgId, userId)` |
| User is added to a new organization | _(no action needed — first request will populate)_ |

```typescript
constructor(private readonly permissions: OrganizationPermissionsService) {}

// after mutating role permissions
await this.permissions.invalidateRole(roleId);

// after mutating user-organization membership
await this.permissions.invalidateUserRole(organizationId, userId);
```

Both methods only delete the copy in **this** service's Redis, and they reject if Redis fails. The caller decides whether that should fail the mutation.

---

## Injection tokens

The SDK exports four injection tokens. **You typically don't need any of these** — they are public so the DI graph is debuggable and so advanced consumers can override providers if needed.

| Token | Resolves to | Notes |
|---|---|---|
| `CS_PERMISSIONS_SDK_OPTIONS` | `CsPermissionsSdkOptions` | The full options object as produced by your `useFactory`. Single source of truth. |
| `PERMISSION_GATEWAY_URL_TOKEN` | `string` | Derived from `options.gatewayUrl`. |
| `PERMISSION_CACHE_TTL_TOKEN` | `number` | Derived from `options.cacheTtlSeconds`, validated at boot. Useful to give your own copies of the same data the same TTL. |
| `PERMISSION_JWT_SECRET_TOKEN` | `string` | _Deprecated._ Resolves to `options.jwtSecret ?? ''`. Kept for backwards compatibility. |

### Why `CS_PERMISSIONS_SDK_OPTIONS` exists

If `forRootAsync` registered every derived provider with its own copy of `useFactory`, NestJS would invoke that factory once per provider. Centralizing the result in `CS_PERMISSIONS_SDK_OPTIONS` ensures the factory runs **once**, and the rest of the providers read from that single value.

---

## Migration from 2.x

`3.0.0` makes `cacheTtlSeconds` a required option. That is the only breaking change: the guards, decorators, keys and request payload are the same.

```typescript
useFactory: (config) => ({
  redisUrl:        config.get('REDIS_URL') ?? '',
  gatewayUrl:      config.get('GATEWAY_URL') ?? '',
  cacheTtlSeconds: 60, // new, required
}),
```

What changes at runtime:

- **The SDK now caches.** In `2.x` both writes were commented out. Every request missed the cache and called the gateway twice, unless some other service had written the keys into the same Redis. From `3.0.0` the SDK writes both keys with `cacheTtlSeconds`.
- **Keys with no expiry stop being served.** These are copies left by earlier writers that never expire. Each one is refetched and rewritten with the TTL the first time it is read. A key nobody reads again, such as one for a deleted role, stays until it is removed by hand:

  ```bash
  # add your connection flags to each redis-cli, e.g. redis-cli -u "$REDIS_URL"
  for pattern in 'role:*:permissions' 'org-roles:*'; do
    redis-cli --scan --pattern "$pattern" | while read -r key; do
      [ "$(redis-cli ttl "$key")" = "-1" ] && redis-cli del "$key"
    done
  done
  ```

- **Mutations can invalidate locally.** Services that change roles or memberships should call `invalidateRole` / `invalidateUserRole` (see [Cache invalidation](#cache-invalidation)).

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
| Endpoint runs but `request.org_user_permissions` is `undefined`, `@CurrentScope()` returns `[]` | Either (a) the guards are not applied — add `@UseGuards(OrganizationRoleGuard, PermissionGuard)` at the controller or method level, or register them globally with `APP_GUARD` (see [Global guards](#global-guards)); or (b) the request was authenticated via api-key and your `AuthGuard` set `request.skip_permissions_check = true` — in that case the absence of `org_user_permissions` is expected (see [Bypassing the guards via a request flag](#bypassing-the-guards-via-a-request-flag)). |
| Permission changes take up to `cacheTtlSeconds` to apply | Expected when the service that made the change did not call `invalidateRole(roleId)`, or when the change was made in another service: each service only drops its own copy. |
| Role reassignment takes up to `cacheTtlSeconds` to apply | Same as above, with `invalidateUserRole(orgId, userId)`. |
| `Error: CsPermissionsSdkModule: cacheTtlSeconds must be a whole number of seconds between 1 and 300` at boot | The option is missing, is a string (parse env vars with `Number(...)`), is not an integer, or is out of range — `60000` means milliseconds were passed. |
| `Ignoring <key>: it never expires, fetching it again` warning | A copy written without an expiry was found and replaced. Expected once per key after upgrading to `3.0.0`. |
| Redis errors at boot (`ECONNREFUSED`) | Wrong `REDIS_URL`, or Redis is not running. |

### Manual cache invalidation

```typescript
import {
  buildRolePermissionsCacheKey,
  buildUserRoleCacheKey,
} from '@serranomatias/cs-permissions-sdk';

// invalidate a role's permissions for everyone using it
await redis.del(buildRolePermissionsCacheKey(roleId));

// invalidate a single user's role membership
await redis.del(buildUserRoleCacheKey(organizationId, userId));
```

Run these against the Redis of each service holding a copy. Without them, every copy still expires within `cacheTtlSeconds`.

---

## Versioning

The SDK follows SemVer. Breaking changes to the public API (guards, decorators, exported interfaces, configuration shape) bump the major version. Internal changes (cache strategy tuning, logger output, new endpoints) ship in minor/patch.

| Version | Notes |
|---|---|
| `3.0.x` | The SDK writes both cache keys with a required `cacheTtlSeconds`. Keys with no expiry, or with a longer one, are refetched. Adds `invalidateRole` / `invalidateUserRole`, the key builders and `PERMISSION_CACHE_TTL_TOKEN`. |
| `2.0.2` – `2.0.3` | `@CurrentScope()` decorator + `hasFullAccess` / `canAccessOnlyOwn` helpers for row-level filtering at the service layer. Added `request.skip_permissions_check` flag for bypassing guards when the request is authenticated via a non-user method (e.g. api-key). |
| `2.0.x` | Two-tier Redis cache (`org-roles:*` + `role:*:permissions`). Removed `OrganizationTokenService`. `jwtSecret` deprecated. |
| `1.0.x` | JWT-based cache. Required `jwtSecret`. Single gateway endpoint `/api/auth/internal/permissions-token`. |

---

## License

MIT
