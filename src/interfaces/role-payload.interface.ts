import { IPermissionPayload } from "./permissions-payload.interface";

export interface IRolePayload {
  user_id: string;
  organization_id: string;
  role_id: string;
  permissions: IPermissionPayload[];
}
