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

interface IFetchTokenRequest {
  organization_id: string;
  user_id: string;
}

interface IFetchTokenResponse {
  token: string;
}

@Injectable()
export class GatewayPermissionsClient {
  private readonly logger = new Logger(GatewayPermissionsClient.name);

  constructor(
    private readonly httpService: HttpService,
    @Inject(PERMISSION_GATEWAY_URL_TOKEN) private readonly gatewayUrl: string,
  ) {}

  async fetchToken(organizationId: string, userId: string): Promise<string> {
    const url = `${this.gatewayUrl.replace(/\/$/, "")}/api/auth/internal/permissions-token`;
    const body: IFetchTokenRequest = {
      organization_id: organizationId,
      user_id: userId,
    };

    try {
      const { data } = await firstValueFrom(
        this.httpService.post<IFetchTokenResponse>(url, body),
      );

      if (!data?.token) {
        throw new Error("Gateway returned an empty permissions token");
      }

      return data.token;
    } catch (err) {
      if (err instanceof AxiosError) {
        const status = err.response?.status ?? "NO_STATUS";
        const responseBody = err.response?.data
          ? JSON.stringify(err.response.data)
          : "<no body>";
        this.logger.error(
          `Failed to fetch permissions token for org=${organizationId} user=${userId}. ` +
            `URL=${url} status=${status} message="${err.message}" response=${responseBody}`,
        );
      } else {
        this.logger.error(
          `Failed to fetch permissions token for org=${organizationId} user=${userId}. ` +
            `URL=${url} message="${(err as Error).message}"`,
        );
      }
      throw new ServiceUnavailableException(
        "Failed to fetch permissions token from gateway",
      );
    }
  }
}
