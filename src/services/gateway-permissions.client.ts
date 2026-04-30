import { HttpService } from "@nestjs/axios";
import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { AxiosError } from "axios";
import { firstValueFrom } from "rxjs";
import { PERMISSION_GATEWAY_URL_TOKEN } from "../constants/sdk-tokens.constant";
import { IPermissionPayload } from "../interfaces/permissions-payload.interface";
import { IUserRole } from "../interfaces/user-role.interface";

interface IFetchUserRoleRequest {
  organization_id: string;
  user_id: string;
}

type MaybeWrapped<T> = T | { data: T };

@Injectable()
export class GatewayPermissionsClient {
  private readonly logger = new Logger(GatewayPermissionsClient.name);

  constructor(
    private readonly httpService: HttpService,
    @Inject(PERMISSION_GATEWAY_URL_TOKEN) private readonly gatewayUrl: string,
  ) {}

  async fetchUserRole(
    organizationId: string,
    userId: string,
  ): Promise<IUserRole> {
    const url = `${this.baseUrl()}/api/roles/internal/user-role`;
    const body: IFetchUserRoleRequest = {
      organization_id: organizationId,
      user_id: userId,
    };

    try {
      const response = await firstValueFrom(
        this.httpService.post<MaybeWrapped<IUserRole>>(url, body),
      );
      const userRole = this.unwrap<IUserRole>(response.data);

      if (
        !userRole?.role_id ||
        !userRole?.user_id ||
        !userRole?.organization_id
      ) {
        throw new Error("Gateway returned an incomplete user-role payload");
      }

      return userRole;
    } catch (err) {
      this.logHttpError(url, err);
      if (err instanceof ServiceUnavailableException) throw err;
      throw new ServiceUnavailableException(
        "Failed to fetch user role from gateway",
      );
    }
  }

  async fetchRolePermissions(roleId: string): Promise<IPermissionPayload[]> {
    const url = `${this.baseUrl()}/api/roles/internal/permissions/${encodeURIComponent(roleId)}`;

    try {
      const response = await firstValueFrom(
        this.httpService.post<MaybeWrapped<IPermissionPayload[]>>(url),
      );
      const permissions = this.unwrap<IPermissionPayload[]>(response.data);

      if (!Array.isArray(permissions)) {
        throw new Error("Gateway returned a non-array permissions payload");
      }

      return permissions;
    } catch (err) {
      this.logHttpError(url, err);
      if (err instanceof ServiceUnavailableException) throw err;
      throw new ServiceUnavailableException(
        "Failed to fetch role permissions from gateway",
      );
    }
  }

  private baseUrl(): string {
    return this.gatewayUrl.replace(/\/$/, "");
  }

  private unwrap<T>(payload: MaybeWrapped<T> | undefined | null): T {
    if (payload === undefined || payload === null) {
      throw new Error("Gateway returned an empty body");
    }
    if (Array.isArray(payload)) {
      return payload as T;
    }
    if (
      typeof payload === "object" &&
      "data" in payload &&
      (payload as { data: T }).data !== undefined
    ) {
      return (payload as { data: T }).data;
    }
    return payload as T;
  }

  private logHttpError(url: string, err: unknown): void {
    if (err instanceof AxiosError) {
      const status = err.response?.status ?? "NO_STATUS";
      const responseBody = err.response?.data
        ? JSON.stringify(err.response.data)
        : "<no body>";
      this.logger.error(
        `Gateway call failed. URL=${url} status=${status} message="${err.message}" response=${responseBody}`,
      );
    } else {
      this.logger.error(
        `Gateway call failed. URL=${url} message="${(err as Error).message}"`,
      );
    }
  }
}
