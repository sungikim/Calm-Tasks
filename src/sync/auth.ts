import { requestUrl } from "obsidian";
import type { PluginSettings, TokenSet } from "./types";

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval?: number;
  message?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  error?: string;
  error_description?: string;
}

const SCOPES = "offline_access Tasks.ReadWrite";
const form = (values: Record<string, string>): string => new URLSearchParams(values).toString();
const tenantValue = (tenant: string): string => tenant.trim() || "common";

export class MicrosoftAuth {
  private cancelled = false;

  constructor(
    private readonly getSettings: () => PluginSettings,
    private readonly saveToken: (token: TokenSet | null) => Promise<void>
  ) {}

  cancelLogin(): void { this.cancelled = true; }

  async beginDeviceLogin(onCode: (code: DeviceCodeResponse) => void): Promise<void> {
    const settings = this.getSettings();
    if (!settings.clientId.trim()) throw new Error("Microsoft Entra Client ID를 먼저 입력하세요.");
    this.cancelled = false;
    const tenant = tenantValue(settings.tenant);
    const response = await requestUrl({
      url: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/devicecode`,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: form({ client_id: settings.clientId.trim(), scope: SCOPES }),
      throw: false
    });
    if (response.status >= 400) {
      const failure = response.json as unknown;
      const description = typeof failure === "object" && failure !== null && "error_description" in failure
        ? String(failure.error_description)
        : undefined;
      throw new Error(description ?? "Device Code 요청에 실패했습니다.");
    }
    const device = response.json as DeviceCodeResponse;
    onCode(device);
    const deadline = Date.now() + device.expires_in * 1000;
    let interval = Math.max(device.interval ?? 5, 5) * 1000;
    while (!this.cancelled && Date.now() < deadline) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, interval));
      const tokenResponse = await requestUrl({
        url: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
        method: "POST",
        contentType: "application/x-www-form-urlencoded",
        body: form({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: settings.clientId.trim(), device_code: device.device_code }),
        throw: false
      });
      const data = tokenResponse.json as TokenResponse;
      if (tokenResponse.status < 400 && data.access_token) {
        await this.saveToken({ accessToken: data.access_token, refreshToken: data.refresh_token ?? "", expiresAt: Date.now() + data.expires_in * 1000 });
        return;
      }
      if (data.error === "authorization_pending") continue;
      if (data.error === "slow_down") { interval += 5000; continue; }
      throw new Error(data.error_description ?? data.error ?? "로그인에 실패했습니다.");
    }
    if (this.cancelled) throw new Error("로그인이 취소되었습니다.");
    throw new Error("로그인 코드가 만료되었습니다. 다시 시도하세요.");
  }

  async getAccessToken(): Promise<string> {
    const settings = this.getSettings();
    const token = settings.token;
    if (!token) throw new Error("Microsoft 계정에 먼저 로그인하세요.");
    if (token.expiresAt > Date.now() + 60_000) return token.accessToken;
    if (!token.refreshToken) throw new Error("로그인이 만료되었습니다. 다시 로그인하세요.");
    const tenant = tenantValue(settings.tenant);
    const response = await requestUrl({
      url: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: form({ client_id: settings.clientId.trim(), grant_type: "refresh_token", refresh_token: token.refreshToken, scope: SCOPES }),
      throw: false
    });
    const data = response.json as TokenResponse;
    if (response.status >= 400 || !data.access_token) {
      await this.saveToken(null);
      throw new Error(data.error_description ?? "로그인이 만료되었습니다. 다시 로그인하세요.");
    }
    const renewed: TokenSet = { accessToken: data.access_token, refreshToken: data.refresh_token ?? token.refreshToken, expiresAt: Date.now() + data.expires_in * 1000 };
    await this.saveToken(renewed);
    return renewed.accessToken;
  }
}
