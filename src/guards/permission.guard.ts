import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { isEmpty } from "lodash";
import { PERMISSION_KEY } from "../decorators/require-permission.decorator";
import { IRequestWithUser } from "../interfaces/request-user.interface";
import { IRequiredPermission } from "../interfaces/required-permission.interface";
import { IRolePayload } from "../interfaces/role-payload.interface";

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<IRequestWithUser>();

    if (request.skip_permissions_check === true) {
      return true;
    }

    const requiredPermission =
      this.reflector.getAllAndOverride<IRequiredPermission>(PERMISSION_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);

    if (!requiredPermission) return true;

    const org = request.org_user_permissions as IRolePayload;

    const permissions = org?.permissions || [];

    if (isEmpty(permissions)) {
      throw new ForbiddenException("Permissions missing");
    }

    const permission = permissions.find(
      (p) =>
        p.feature === requiredPermission.feature &&
        p.action === requiredPermission.action,
    );

    if (!permission) {
      throw new ForbiddenException("Permission denied");
    }

    // Agregar permiso a la request (?)
    //request.permission = permission;

    return true;
  }
}
