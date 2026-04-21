export interface IOrganizationRole {
  id: string;
  name: string;
  description: string;
  organization_id: string;
  is_system?: boolean;
  created_at: Date;
}
