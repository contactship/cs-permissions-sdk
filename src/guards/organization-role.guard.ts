import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ORG_TOKEN_HEADER } from "../constants/org-token-header.constant";
import { IRequestWithUser } from "../interfaces/request-user.interface";

export const PERMISSION_JWT_SECRET_TOKEN = "SDK_JWT_SECRET";

@Injectable()
export class OrganizationRoleGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    @Inject(PERMISSION_JWT_SECRET_TOKEN) private readonly jwtSecret: string,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<IRequestWithUser>();

    const orgToken = request.headers[ORG_TOKEN_HEADER];
    const userData = request.user;

    if (!orgToken) {
      throw new ForbiddenException(
        "Unauthorized user - organization token is missing",
      );
    }

    const decoded = this.jwtService.verify(orgToken as string, {
      secret: this.jwtSecret,
    });

    if (!decoded || decoded.user_id !== userData.id) {
      throw new ForbiddenException("Invalid organization token");
    }

    request.org_user_permissions = decoded;

    return true;
  }
}
