import { RoleScopeEnum } from "../enums/scope.enum";

export interface IRolePermission {
  role_id: string;
  permission_id: string;
  scope?: RoleScopeEnum[] | null;
  created_at: Date;
}
