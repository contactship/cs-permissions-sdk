import { ExecutionContext, createParamDecorator } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { RoleScopeEnum } from "../enums/scope.enum";
import { IRequestWithUser } from "../interfaces/request-user.interface";
import { IRequiredPermission } from "../interfaces/required-permission.interface";
import { PERMISSION_KEY } from "./require-permission.decorator";

export interface ICurrentScopeOptions {
  feature?: string;
  action?: string;
}

export const CurrentScope = createParamDecorator(
  (
    opts: ICurrentScopeOptions | undefined,
    context: ExecutionContext,
  ): RoleScopeEnum[] => {
    const request = context.switchToHttp().getRequest<IRequestWithUser>();
    const permissions = request.org_user_permissions?.permissions ?? [];

    let feature = opts?.feature;
    let action = opts?.action;

    if (!feature || !action) {
      const reflector = new Reflector();
      const required = reflector.getAllAndOverride<IRequiredPermission>(
        PERMISSION_KEY,
        [context.getHandler(), context.getClass()],
      );
      feature = feature ?? required?.feature;
      action = action ?? required?.action;
    }

    if (!feature || !action) return [];

    const match = permissions.find(
      (p) => p.feature === feature && p.action === action,
    );

    return (match?.scope ?? []) as RoleScopeEnum[];
  },
);
