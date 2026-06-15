import { IUserWithoutPassword } from "./auth-user.interface";
import { IRolePayload } from "./role-payload.interface";
import { Request } from "express";

export interface IRequestWithUser extends Request {
  user: IUserWithoutPassword;
  organization_id?: string;
  org_user_permissions?: IRolePayload;
  skip_permissions_check?: boolean;
}
