export interface IUserOrganization {
  user_id: string;
  organization_id: string;
  role_id: string;
  created_at: Date;
  is_owner?: boolean;
  org_role_id: string;
  deleted_at?: Date;
}
