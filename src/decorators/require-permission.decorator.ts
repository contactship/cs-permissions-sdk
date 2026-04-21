import { SetMetadata } from "@nestjs/common";
import { IRequiredPermission } from "../interfaces/required-permission.interface";

export const PERMISSION_KEY = "permission";

export const RequirePermission = (permission: IRequiredPermission) =>
  SetMetadata(PERMISSION_KEY, permission);
