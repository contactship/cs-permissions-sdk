import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { ORG_ID_HEADER } from "../constants/org-id-header.constant";
import { PERMISSION_JWT_SECRET_TOKEN } from "../constants/sdk-tokens.constant";
import { IRequestWithUser } from "../interfaces/request-user.interface";
import { OrganizationTokenService } from "../services/organization-token.service";

export { PERMISSION_JWT_SECRET_TOKEN };

@Injectable()
export class OrganizationRoleGuard implements CanActivate {
  private readonly logger = new Logger(OrganizationRoleGuard.name);

  constructor(
    private readonly organizationTokenService: OrganizationTokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<IRequestWithUser>();

    const organizationId = request.headers[ORG_ID_HEADER] as string | undefined;
    const user = request.user;

    if (!organizationId) {
      throw new UnauthorizedException(
        "Missing organization id header (x-organization-id)",
      );
    }

    if (!user?.id) {
      throw new UnauthorizedException("Authenticated user is missing");
    }

    try {
      const payload = await this.organizationTokenService.getOrRequestToken(
        organizationId,
        user.id,
      );

      if (
        payload.user_id !== user.id ||
        payload.organization_id !== organizationId
      ) {
        throw new UnauthorizedException(
          "Permissions token does not match request context",
        );
      }

      request.org_user_permissions = payload;
      request.organization_id = organizationId;

      return true;
    } catch (err) {
      if (err instanceof UnauthorizedException) {
        throw err;
      }
      this.logger.error(
        `Failed to authorize org=${organizationId} user=${user.id}: ${(err as Error).message}`,
      );
      throw new UnauthorizedException("Could not authorize organization access");
    }
  }
}
