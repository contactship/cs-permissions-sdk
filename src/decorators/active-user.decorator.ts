import { ExecutionContext, createParamDecorator } from "@nestjs/common";
import { IRequestWithUser } from "../interfaces/request-user.interface";

export const ActiveUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => {
    const request = context.switchToHttp().getRequest<IRequestWithUser>();

    return request.user;
  },
);
