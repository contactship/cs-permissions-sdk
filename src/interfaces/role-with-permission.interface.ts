import { RoleScopeEnum } from "../enums/scope.enum";
import { IPermission } from "./permission.interface";

export interface IRoleWithPermission {
  role_id: string;
  scope?: RoleScopeEnum[] | null;
  permission: IPermission;
}
