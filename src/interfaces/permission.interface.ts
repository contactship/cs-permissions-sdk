import { RoleActionEnum } from "../enums/actions.enum";
import { RoleFeatureEnum } from "../enums/features.enum";

export interface IPermission {
  id: string;
  feature: RoleFeatureEnum;
  action: RoleActionEnum;
  description?: string;
}
