import { RoleActionEnum } from "../enums/actions.enum";
import { RoleFeatureEnum } from "../enums/features.enum";
import { RoleScopeEnum } from "../enums/scope.enum";

export interface IPermissionPayload {
  feature: RoleFeatureEnum;
  action: RoleActionEnum;
  scope?: RoleScopeEnum[] | null;
}
