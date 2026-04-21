export interface IRequiredPermission {
  feature: string;
  action: string;
  scope?: string[] | null;
}
