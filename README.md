# @briansleonel/cs-permissions-sdk

NestJS SDK that centralizes **organization-scoped role-based access control (RBAC)** for a microservices ecosystem. It transparently handles JWT signing, Redis caching, and remote permission resolution against a central gateway, exposing a simple guard + decorator API to the consuming service.

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
- [Injection tokens](#injection-tokens)
- [Troubleshooting](#troubleshooting)

---

## Architecture

```
┌────────────┐  x-organization-id   ┌─────────────────────────────────────────┐
│  Frontend  │ ───────────────────► │  Microservice (consumer)                │
└────────────┘                      │                                         │
                                    │   ┌─────────────────────────────────┐   │
                                    │   │ UserFromGatewayMiddleware       │   │  ← injects request.user
                                    │   └─────────────────────────────────┘   │
                                    │                  │                      │
                                    │                  ▼                      │
                                    │   ┌─────────────────────────────────┐   │
                                    │   │ OrganizationRoleGuard (SDK)     │   │
                                    │   │  └─► OrganizationTokenService   │   │
                                    │   │        ├─► Redis  GET key       │   │
                                    │   │        ├─► HTTP   POST gateway  │───┼──► Gateway
                                    │   │        └─► JWT    verify+decode │   │       /internal/permissions-token
                                    │   └─────────────────────────────────┘   │
                                    │                  │                      │
                                    │                  ▼                      │
                                    │   ┌─────────────────────────────────┐   │
                                    │   │ PermissionGuard (SDK)           │   │
                                    │   │   reads request.org_user_       │   │
                                    │   │   permissions and matches       │   │
                                    │   │   @RequirePermission metadata   │   │
                                    │   └─────────────────────────────────┘   │
                                    │                  │                      │
                                    │                  ▼                      │
                                    │              Controller                 │
                                    └─────────────────────────────────────────┘
```

**Responsibilities**

| Layer | Owns |
|---|---|
| Gateway (external) | Database access, role/permission computation, JWT signing |
| SDK | Cache, JWT verification, header parsing, request enrichment, permission matching |
| Consumer service | Business logic, controllers, declaring required permissions |

The SDK **never** touches the auth/roles database. All token issuance is delegated to the gateway over HTTP, and results are cached in Redis to avoid hitting the gateway on every request.

---

## Installation

```bash
npm install @briansleonel/cs-permissions-sdk
```

### Peer dependencies

The SDK declares the following peer dependencies — your service must install them:

```bash
npm install \
  @nestjs/common @nestjs/core @nestjs/jwt \
  @nestjs/axios axios rxjs \
  @nestjs-modules/ioredis ioredis
```

| Package | Why |
|---|---|
| `@nestjs/common`, `@nestjs/core` | NestJS runtime |
| `@nestjs/jwt` | JWT verification (verify-only — signing happens at the gateway) |
| `@nestjs/axios`, `axios`, `rxjs` | HTTP client used by `GatewayPermissionsClient` |
| `@nestjs-modules/ioredis`, `ioredis` | Redis client for the token cache |

---

## Configuration

The SDK is registered **once** in your `AppModule` via `forRoot` or `forRootAsync`. It is a `@Global()` module, so all other modules in your service can use the guards without re-importing.

### Configuration shape

```typescript
interface CsPermissionsSdkOptions {
  jwtSecret: string;   // shared secret used to verify tokens issued by the gateway
  redisUrl: string;    // ioredis connection string, e.g. redis://localhost:6379
  gatewayUrl: string;  // base URL of the gateway service (no trailing slash needed)
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
        jwtSecret: config.get<string>('JWT_SECRET_API_KEY') ?? '',
        redisUrl:  config.get<string>('REDIS_URL') ?? '',
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
  jwtSecret:  'super-secret',
  redisUrl:   'redis://localhost:6379',
  gatewayUrl: 'https://gateway.internal',
}),
```

### Required environment variables (suggested)

| Var | Example | Purpose |
|---|---|---|
| `JWT_SECRET_API_KEY` | `change-me` | Must match the secret the gateway uses to sign permissions tokens |
| `REDIS_URL` | `redis://localhost:6379` | Redis instance used for the token cache |
| `GATEWAY_URL` | `https://gateway.internal` | Base URL of the gateway HTTP service |

---

## Required upstream contract

For the SDK to work, two upstream components must be in place:

### 1. Authentication middleware (in your service)

A middleware running **before** the SDK guards must populate `request.user` with at least:

```typescript
request.user = { id: string, /* ...rest of your user shape */ };
```

In the existing ecosystem this is `UserFromGatewayMiddleware`. The SDK uses `request.user.id` to ask the gateway for that user's permissions inside the requested organization.

### 2. Gateway endpoint (the central service)

The SDK calls the gateway with this contract:

**`POST {gatewayUrl}/internal/permissions-token`**

Request body:
```json
{
  "organization_id": "uuid",
  "user_id": "uuid"
}
```

Response body:
```json
{ "token": "eyJhbGciOi..." }
```

The `token` must be a JWT signed with the same `jwtSecret` configured in the SDK, and its decoded payload must conform to [`IRolePayload`](#irolepayload):

```typescript
{
  user_id: string;
  organization_id: string;
  role_id: string;
  permissions: { feature: string; action: string; scope?: string[] | null }[];
}
```

A reference implementation on the gateway side (already in production):

```typescript
// gateway side
const rolePayload = await retrieveRolePayloadAction.execute(userId, organizationId);
const { token }   = await generateRolePermissionsTokenAction.execute(rolePayload);
return { token };
```

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

Reads the `x-organization-id` header and the authenticated `request.user.id`, then asks `OrganizationTokenService` for the role payload (cached in Redis or fetched from the gateway). On success it sets:

- `request.org_user_permissions` → `IRolePayload`
- `request.organization_id` → `string`

Throws `UnauthorizedException` if:
- the header is missing,
- `request.user` is missing,
- the gateway is unreachable or returns an empty token,
- the JWT signature fails or the payload doesn't match the request context.

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

The decoded JWT payload returned by the gateway and cached in Redis.

```typescript
interface IRolePayload {
  user_id: string;
  organization_id: string;
  role_id: string;
  permissions: IPermissionPayload[];
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

These services are exported in case you need to use them outside the guards (for example in custom middleware, background jobs, or scripts). In day-to-day controller code you don't need them.

### `OrganizationTokenService`

```typescript
getOrRequestToken(organizationId: string, userId: string): Promise<IRolePayload>
```

Resolves the role payload using this strategy:

1. Lookup `permissions-token:{organizationId}:{userId}` in Redis.
2. **Hit:** if the TTL is `≤ 5 minutes`, refresh by calling the gateway and overwrite the cache (TTL = 1h). Otherwise reuse the cached token. Either way, decode and return the payload.
3. **Miss:** call the gateway, store the token in Redis with TTL = 1h, decode, return.

### `GatewayPermissionsClient`

```typescript
fetchToken(organizationId: string, userId: string): Promise<string>
```

Performs `POST {gatewayUrl}/internal/permissions-token` with body `{ organization_id, user_id }` and returns the JWT string from `response.data.token`. Throws `ServiceUnavailableException` on failure.

---

## Caching strategy

| Property | Value |
|---|---|
| Redis key | `permissions-token:{organizationId}:{userId}` |
| Stored value | The raw JWT string returned by the gateway |
| TTL | `3600` seconds (1 hour) |
| Refresh threshold | `300` seconds (5 minutes before expiry) |

Implications:
- Permission changes propagate to a logged-in user **after at most 1 hour**, or sooner if the cache is invalidated externally (the gateway can `DEL` the key when a role changes).
- If your gateway updates a user's role and you need it to apply immediately, the gateway should `DEL permissions-token:{orgId}:{userId}` after the change.

---

## Injection tokens

The SDK exports three injection tokens. **You typically don't need any of these** — they are public only so the DI graph remains debuggable and so advanced consumers can override providers if they really need to.

| Token | Resolves to | Notes |
|---|---|---|
| `CS_PERMISSIONS_SDK_OPTIONS` | `CsPermissionsSdkOptions` | The full options object as produced by your `useFactory`. Internal — used as the single source of truth for the other tokens. |
| `PERMISSION_JWT_SECRET_TOKEN` | `string` | Derived from `options.jwtSecret`. |
| `PERMISSION_GATEWAY_URL_TOKEN` | `string` | Derived from `options.gatewayUrl`. |

### Why `CS_PERMISSIONS_SDK_OPTIONS` exists

If `forRootAsync` registered every derived provider with its own copy of `useFactory`, NestJS would invoke that factory once per provider (3+ times). Centralizing the result in `CS_PERMISSIONS_SDK_OPTIONS` ensures the factory runs **once**, and the rest of the providers (jwt secret, gateway url, RedisModule) read from that single value.

You only need to interact with this token if you're extending the SDK with new providers that also need to read configuration.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `UnauthorizedException: Missing organization id header` | Frontend didn't send `x-organization-id`. |
| `UnauthorizedException: Authenticated user is missing` | Your auth/user middleware is not running before the guards, or didn't set `request.user.id`. |
| `UnauthorizedException: Permissions token does not match request context` | The gateway returned a token for a different `user_id`/`organization_id`. Likely a bug in the gateway or a mismatch in `jwtSecret`. |
| `ServiceUnavailableException: Failed to fetch permissions token from gateway` | Gateway is down, unreachable, returning non-2xx, or returning an empty `token` field. Check `GATEWAY_URL` and gateway logs. |
| `JsonWebTokenError: invalid signature` | The `JWT_SECRET_API_KEY` in your service does not match the one used by the gateway to sign tokens. |
| Permission changes don't take effect | Cached token still valid (≤1h TTL). The gateway should `DEL permissions-token:{orgId}:{userId}` after role updates to invalidate the cache. |
| Redis errors at boot (`ECONNREFUSED`) | Wrong `REDIS_URL`, or Redis is not running. |

### Manual cache invalidation (gateway side)

```typescript
await redis.del(`permissions-token:${organizationId}:${userId}`);
```

---

## Versioning

The SDK follows SemVer. Breaking changes to the public API (guards, decorators, exported interfaces, configuration shape) bump the major version. Internal changes (cache strategy tuning, logger output, token name fixes) ship in minor/patch.

---

## License

MIT
