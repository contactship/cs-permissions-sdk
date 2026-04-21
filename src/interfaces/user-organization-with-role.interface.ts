import { IOrganizationRole } from "./role.interface";
import { IUserOrganization } from "./user-organization.interface";


export interface IUserOrganizationWithRole extends IUserOrganization {
  role: IOrganizationRole;
}
