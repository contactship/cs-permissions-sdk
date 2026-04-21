import { IUser } from "../interfaces/user.interface";

export interface IUserWithoutPassword extends Omit<
  IUser,
  "encrypted_password"
> {}
