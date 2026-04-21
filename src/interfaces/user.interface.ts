import { AuthProviderEnum } from "../enums/auth-provider.enum";

export interface IUser {
  id: string;
  avatars: string;
  full_name: string;
  username: string;
  avatar_url: string;
  website: string;
  aud: string;
  encrypted_password: string;
  phone: string;
  email: string;
  created_at: string;
  deleted_at: string;
  is_sso_user: boolean;
  is_user: boolean;
  job_occupation: string;
  referral_source: string;
  is_legacy?: boolean;
  provider?: AuthProviderEnum;
  plan_id?: string;
  email_verified_at?: Date | null;
}
