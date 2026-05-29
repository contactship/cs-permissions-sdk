import { RoleScopeEnum } from "../enums/scope.enum";

export const hasFullAccess = (
  scope: RoleScopeEnum[] | null | undefined,
): boolean => (scope ?? []).includes(RoleScopeEnum.ALL);

export const canAccessOnlyOwn = (
  scope: RoleScopeEnum[] | null | undefined,
): boolean => {
  const s = scope ?? [];
  return s.includes(RoleScopeEnum.OWN) && !s.includes(RoleScopeEnum.ALL);
};
