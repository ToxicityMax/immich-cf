/**
 * System config service -- Workers-compatible version.
 *
 * Uses the config system from CP-3 (KV-cached, D1-backed).
 * No NestJS, no events, no config file support.
 */

import type { SystemConfig } from 'src/config';
import { getConfig, getDefaults, updateConfig } from 'src/config';
import type { ServiceContext } from 'src/context';

export class SystemConfigService {
  constructor(private ctx: ServiceContext) {}

  async getSystemConfig(): Promise<SystemConfig> {
    return getConfig(this.ctx.env);
  }

  getDefaults(): SystemConfig {
    return getDefaults();
  }

  async getAdminConfig(): Promise<SystemConfig> {
    return this.getSystemConfig();
  }

  getAdminConfigDefaults(): SystemConfig {
    return this.getDefaults();
  }

  async getUserConfig() {
    return this.toUserConfig(await getConfig(this.ctx.env));
  }

  getUserConfigDefaults() {
    return this.toUserConfig(getDefaults());
  }

  async getPublicConfig() {
    return this.toPublicConfig(await getConfig(this.ctx.env));
  }

  getPublicConfigDefaults() {
    return this.toPublicConfig(getDefaults());
  }

  async updateSystemConfig(dto: unknown): Promise<SystemConfig> {
    const config = await updateConfig(this.ctx.env, dto);
    await this.ctx.realtime.broadcast('on_config_update');
    return config;
  }

  async getCustomCss(): Promise<string> {
    const config = await getConfig(this.ctx.env);
    return config.theme.customCss;
  }

  private toPublicConfig(config: SystemConfig) {
    return {
      oauth: {
        autoLaunch: config.oauth.autoLaunch,
        buttonText: config.oauth.buttonText,
        enabled: config.oauth.enabled,
      },
      passwordLogin: {
        enabled: config.passwordLogin.enabled,
      },
      server: {
        loginPageMessage: config.server.loginPageMessage,
      },
      theme: {
        customCss: config.theme.customCss,
      },
    };
  }

  private toUserConfig(config: SystemConfig) {
    return {
      ffmpeg: { realtime: config.ffmpeg.realtime },
      image: {
        thumbnail: { size: config.image.thumbnail.size },
        preview: { size: config.image.preview.size },
        fullsize: { enabled: config.image.fullsize.enabled },
      },
      machineLearning: {
        enabled: config.machineLearning.enabled,
        clip: { enabled: config.machineLearning.clip.enabled },
        duplicateDetection: { enabled: config.machineLearning.duplicateDetection.enabled },
        facialRecognition: {
          enabled: config.machineLearning.facialRecognition.enabled,
          minFaces: config.machineLearning.facialRecognition.minFaces,
        },
        ocr: { enabled: config.machineLearning.ocr.enabled },
      },
      map: config.map,
      oauth: {
        autoLaunch: config.oauth.autoLaunch,
        buttonText: config.oauth.buttonText,
        enabled: config.oauth.enabled,
      },
      passwordLogin: config.passwordLogin,
      reverseGeocoding: config.reverseGeocoding,
      server: config.server,
      theme: config.theme,
      trash: config.trash,
      user: config.user,
    };
  }
}
