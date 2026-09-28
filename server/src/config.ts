import { z } from 'zod';
import type { Env } from './env';

const CONFIG_KEY = 'system:config';
const CONFIG_TTL = 60;

const bool = z.boolean();
const positiveInt = z.number().int().positive();
const nonnegativeInt = z.number().int().nonnegative();
const jobSettings = z.object({ concurrency: positiveInt }).strict();
const generatedImage = z.object({
  format: z.enum(['jpeg', 'webp']),
  quality: z.number().int().min(1).max(100),
  size: positiveInt,
  progressive: bool.optional().default(false),
}).strict();
const integrityJob = z.object({ enabled: bool, cronExpression: z.string().min(1) }).strict();
const machineLearningTask = z.object({ enabled: bool }).strict();

export const SystemConfigSchema = z.object({
  backup: z.object({
    database: z.object({
      enabled: bool,
      cronExpression: z.string().min(1),
      keepLastAmount: positiveInt,
    }).strict(),
  }).strict(),
  ffmpeg: z.object({
    crf: z.number().int().min(0).max(51),
    threads: nonnegativeInt,
    preset: z.string(),
    targetVideoCodec: z.enum(['h264', 'hevc', 'vp9', 'av1']),
    acceptedVideoCodecs: z.array(z.enum(['h264', 'hevc', 'vp9', 'av1'])),
    targetAudioCodec: z.enum(['aac', 'mp3', 'opus']),
    acceptedAudioCodecs: z.array(z.enum(['aac', 'mp3', 'opus'])),
    acceptedContainers: z.array(z.enum(['mov', 'ogg', 'webm'])),
    targetResolution: z.string(),
    maxBitrate: z.string(),
    bframes: z.number().int().min(-1).max(16),
    refs: z.number().int().min(0).max(6),
    gopSize: nonnegativeInt,
    temporalAQ: bool,
    cqMode: z.enum(['auto', 'cqp', 'icq']),
    twoPass: bool,
    preferredHwDevice: z.string(),
    transcode: z.enum(['required', 'optimal', 'bitrate', 'disabled']),
    accel: z.enum(['disabled', 'nvenc', 'qsv', 'vaapi', 'rkmpp']),
    accelDecode: bool,
    tonemap: z.enum(['hable', 'mobius', 'reinhard', 'disabled']),
    realtime: z.object({
      enabled: bool,
      videoCodecs: z.array(z.enum(['h264', 'hevc', 'vp9', 'av1'])),
      resolutions: z.array(z.enum(['480p', '720p', '1080p', '1440p', '2160p'])),
    }).strict(),
  }).strict(),
  integrityChecks: z.object({
    missingFiles: integrityJob,
    untrackedFiles: integrityJob,
    checksumFiles: integrityJob.extend({
      timeLimit: nonnegativeInt,
      percentageLimit: z.number().min(0).max(1),
    }).strict(),
  }).strict(),
  job: z.object({
    thumbnailGeneration: jobSettings,
    metadataExtraction: jobSettings,
    videoConversion: jobSettings,
    faceDetection: jobSettings,
    smartSearch: jobSettings,
    backgroundTask: jobSettings,
    migration: jobSettings,
    search: jobSettings,
    sidecar: jobSettings,
    library: jobSettings,
    notifications: jobSettings,
    ocr: jobSettings,
    workflow: jobSettings,
    editor: jobSettings,
    integrityCheck: jobSettings,
  }).strict(),
  logging: z.object({ enabled: bool, level: z.enum(['verbose', 'debug', 'log', 'warn', 'error', 'fatal']) }).strict(),
  machineLearning: z.object({
    enabled: bool,
    urls: z.array(z.string()).min(1),
    availabilityChecks: z.object({ enabled: bool, timeout: nonnegativeInt, interval: nonnegativeInt }).strict(),
    clip: machineLearningTask.extend({ modelName: z.string() }).strict(),
    duplicateDetection: machineLearningTask.extend({ maxDistance: z.number().min(0.001).max(0.1) }).strict(),
    facialRecognition: machineLearningTask.extend({
      modelName: z.string(),
      minScore: z.number().min(0.1).max(1),
      maxDistance: z.number().min(0.1).max(2),
      minFaces: positiveInt,
    }).strict(),
    ocr: machineLearningTask.extend({
      modelName: z.string(),
      minDetectionScore: z.number().min(0.1).max(1),
      minRecognitionScore: z.number().min(0.1).max(1),
      maxResolution: positiveInt,
    }).strict(),
  }).strict(),
  map: z.object({ enabled: bool, lightStyle: z.string().url(), darkStyle: z.string().url() }).strict(),
  reverseGeocoding: z.object({ enabled: bool }).strict(),
  metadata: z.object({ faces: z.object({ import: bool }).strict() }).strict(),
  oauth: z.object({
    autoLaunch: bool,
    autoRegister: bool,
    buttonText: z.string(),
    clientId: z.string(),
    clientSecret: z.string(),
    tokenEndpointAuthMethod: z.enum(['client_secret_post', 'client_secret_basic']),
    timeout: positiveInt,
    allowInsecureRequests: bool,
    defaultStorageQuota: nonnegativeInt.nullable(),
    enabled: bool,
    issuerUrl: z.string(),
    accountManagementUrl: z.string(),
    scope: z.string(),
    prompt: z.string(),
    endSessionEndpoint: z.string(),
    signingAlgorithm: z.string(),
    profileSigningAlgorithm: z.string(),
    storageLabelClaim: z.string(),
    storageQuotaClaim: z.string(),
    roleClaim: z.string(),
    mobileOverrideEnabled: bool,
    mobileRedirectUri: z.string(),
  }).strict(),
  passwordLogin: z.object({ enabled: bool }).strict(),
  storageTemplate: z.object({ enabled: bool, hashVerificationEnabled: bool, template: z.string() }).strict(),
  image: z.object({
    thumbnail: generatedImage,
    preview: generatedImage,
    fullsize: z.object({
      enabled: bool,
      format: z.enum(['jpeg', 'webp']),
      quality: z.number().int().min(1).max(100),
      progressive: bool.optional().default(false),
    }).strict(),
    colorspace: z.enum(['p3', 'srgb']),
    extractEmbedded: bool,
  }).strict(),
  newVersionCheck: z.object({ enabled: bool, channel: z.enum(['stable', 'beta']) }).strict(),
  nightlyTasks: z.object({
    startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    databaseCleanup: bool,
    missingThumbnails: bool,
    clusterNewFaces: bool,
    generateMemories: bool,
    syncQuotaUsage: bool,
  }).strict(),
  trash: z.object({ enabled: bool, days: nonnegativeInt }).strict(),
  theme: z.object({ customCss: z.string() }).strict(),
  library: z.object({
    scan: z.object({ enabled: bool, cronExpression: z.string().min(1) }).strict(),
    watch: z.object({ enabled: bool }).strict(),
  }).strict(),
  notifications: z.object({
    smtp: z.object({
      enabled: bool,
      from: z.string(),
      replyTo: z.string(),
      transport: z.object({
        ignoreCert: bool,
        host: z.string(),
        port: z.number().int().min(0).max(65_535),
        secure: bool,
        username: z.string(),
        password: z.string(),
      }).strict(),
    }).strict(),
  }).strict(),
  templates: z.object({
    email: z.object({ welcomeTemplate: z.string(), albumInviteTemplate: z.string(), albumUpdateTemplate: z.string() }).strict(),
  }).strict(),
  server: z.object({ externalDomain: z.string(), loginPageMessage: z.string(), publicUsers: bool }).strict(),
  user: z.object({ deleteDelay: positiveInt }).strict(),
}).strict();

export type SystemConfig = z.infer<typeof SystemConfigSchema>;

export const defaults: SystemConfig = {
  backup: { database: { enabled: false, cronExpression: '0 0 2 * * *', keepLastAmount: 14 } },
  ffmpeg: {
    crf: 23, threads: 0, preset: 'ultrafast', targetVideoCodec: 'h264', acceptedVideoCodecs: ['h264'],
    targetAudioCodec: 'aac', acceptedAudioCodecs: ['aac', 'mp3', 'opus'], acceptedContainers: ['mov', 'ogg', 'webm'],
    targetResolution: '720', maxBitrate: '0', bframes: -1, refs: 0, gopSize: 0, temporalAQ: false,
    cqMode: 'auto', twoPass: false, preferredHwDevice: 'auto', transcode: 'disabled', accel: 'disabled',
    accelDecode: false, tonemap: 'disabled',
    realtime: { enabled: false, videoCodecs: ['h264', 'hevc'], resolutions: ['480p', '720p', '1080p'] },
  },
  integrityChecks: {
    missingFiles: { enabled: false, cronExpression: '0 0 3 * * *' },
    untrackedFiles: { enabled: false, cronExpression: '0 0 3 * * *' },
    checksumFiles: { enabled: false, cronExpression: '0 0 3 * * *', timeLimit: 3_600_000, percentageLimit: 1 },
  },
  job: {
    thumbnailGeneration: { concurrency: 3 }, metadataExtraction: { concurrency: 5 }, videoConversion: { concurrency: 1 },
    faceDetection: { concurrency: 2 }, smartSearch: { concurrency: 2 }, backgroundTask: { concurrency: 5 },
    migration: { concurrency: 5 }, search: { concurrency: 5 }, sidecar: { concurrency: 5 }, library: { concurrency: 5 },
    notifications: { concurrency: 5 }, ocr: { concurrency: 1 }, workflow: { concurrency: 5 }, editor: { concurrency: 2 },
    integrityCheck: { concurrency: 1 },
  },
  logging: { enabled: true, level: 'log' },
  machineLearning: {
    enabled: false, urls: ['http://immich-machine-learning:3003'], availabilityChecks: { enabled: false, timeout: 2000, interval: 30_000 },
    clip: { enabled: false, modelName: 'ViT-B-32__openai' },
    duplicateDetection: { enabled: false, maxDistance: 0.01 },
    facialRecognition: { enabled: false, modelName: 'buffalo_l', minScore: 0.7, maxDistance: 0.5, minFaces: 3 },
    ocr: { enabled: false, modelName: 'PP-OCRv5_mobile', minDetectionScore: 0.5, minRecognitionScore: 0.8, maxResolution: 736 },
  },
  map: { enabled: false, lightStyle: 'https://tiles.immich.cloud/v1/style/light.json', darkStyle: 'https://tiles.immich.cloud/v1/style/dark.json' },
  reverseGeocoding: { enabled: false },
  metadata: { faces: { import: false } },
  oauth: {
    autoLaunch: false, autoRegister: true, buttonText: 'Login with OAuth', clientId: '', clientSecret: '',
    tokenEndpointAuthMethod: 'client_secret_post', timeout: 30_000, allowInsecureRequests: false,
    defaultStorageQuota: null, enabled: false, issuerUrl: '', accountManagementUrl: '', scope: 'openid email profile',
    prompt: '', endSessionEndpoint: '', signingAlgorithm: 'RS256', profileSigningAlgorithm: 'none',
    storageLabelClaim: 'preferred_username', storageQuotaClaim: 'immich_quota', roleClaim: 'immich_role',
    mobileOverrideEnabled: false, mobileRedirectUri: '',
  },
  passwordLogin: { enabled: true },
  storageTemplate: { enabled: false, hashVerificationEnabled: true, template: '{{y}}/{{y}}-{{MM}}-{{dd}}/{{filename}}' },
  image: {
    thumbnail: { format: 'webp', size: 250, quality: 80, progressive: false },
    preview: { format: 'jpeg', size: 1440, quality: 80, progressive: false },
    fullsize: { enabled: false, format: 'jpeg', quality: 80, progressive: false },
    colorspace: 'p3', extractEmbedded: false,
  },
  newVersionCheck: { enabled: false, channel: 'stable' },
  nightlyTasks: { startTime: '00:00', databaseCleanup: false, missingThumbnails: false, clusterNewFaces: false, generateMemories: false, syncQuotaUsage: false },
  trash: { enabled: true, days: 30 },
  theme: { customCss: '' },
  library: { scan: { enabled: false, cronExpression: '0 0 0 * * *' }, watch: { enabled: false } },
  notifications: { smtp: { enabled: false, from: '', replyTo: '', transport: { ignoreCert: false, host: '', port: 587, secure: false, username: '', password: '' } } },
  templates: { email: { welcomeTemplate: '', albumInviteTemplate: '', albumUpdateTemplate: '' } },
  server: { externalDomain: '', loginPageMessage: '', publicUsers: true },
  user: { deleteDelay: 7 },
};

const clone = <T>(value: T): T => structuredClone(value);

function disableUnsupported(config: SystemConfig): SystemConfig {
  const value = clone(config);
  value.backup.database.enabled = false;
  value.ffmpeg.transcode = 'disabled';
  value.ffmpeg.realtime.enabled = false;
  value.integrityChecks.missingFiles.enabled = false;
  value.integrityChecks.untrackedFiles.enabled = false;
  value.integrityChecks.checksumFiles.enabled = false;
  value.library.scan.enabled = false;
  value.library.watch.enabled = false;
  value.machineLearning.enabled = false;
  value.machineLearning.availabilityChecks.enabled = false;
  value.machineLearning.clip.enabled = false;
  value.machineLearning.duplicateDetection.enabled = false;
  value.machineLearning.facialRecognition.enabled = false;
  value.machineLearning.ocr.enabled = false;
  value.map.enabled = false;
  value.metadata.faces.import = false;
  value.newVersionCheck.enabled = false;
  value.nightlyTasks.databaseCleanup = false;
  value.nightlyTasks.missingThumbnails = false;
  value.nightlyTasks.clusterNewFaces = false;
  value.nightlyTasks.generateMemories = false;
  value.nightlyTasks.syncQuotaUsage = false;
  value.notifications.smtp.enabled = false;
  value.oauth.enabled = false;
  value.oauth.autoLaunch = false;
  value.reverseGeocoding.enabled = false;
  value.storageTemplate.enabled = false;
  value.image.fullsize.enabled = false;
  return value;
}

export function parseSystemConfig(value: unknown): SystemConfig {
  return disableUnsupported(SystemConfigSchema.parse(value));
}

export function getDefaults(): SystemConfig {
  return clone(defaults);
}

export async function getConfig(env: Env): Promise<SystemConfig> {
  const cached = await env.KV.get(CONFIG_KEY, 'json');
  if (cached) {
    return parseSystemConfig(cached);
  }

  const config = await loadConfigFromD1(env);
  await env.KV.put(CONFIG_KEY, JSON.stringify(config), { expirationTtl: CONFIG_TTL });
  return config;
}

export async function updateConfig(env: Env, input: unknown): Promise<SystemConfig> {
  const config = parseSystemConfig(input);
  await env.DB.prepare('INSERT OR REPLACE INTO system_metadata (key, value) VALUES (?, ?)')
    .bind('system-config', JSON.stringify(config))
    .run();
  await env.KV.delete(CONFIG_KEY);
  return config;
}

async function loadConfigFromD1(env: Env): Promise<SystemConfig> {
  try {
    const result = await env.DB.prepare('SELECT value FROM system_metadata WHERE key = ?')
      .bind('system-config')
      .first<{ value: string }>();
    if (result?.value) {
      return parseSystemConfig(deepMerge(defaults, JSON.parse(result.value)));
    }
  } catch {
    // The database may not be initialized during early startup.
  }
  return getDefaults();
}

function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
  const result = clone(target);
  for (const key of Object.keys(source) as Array<keyof T>) {
    const sourceValue = source[key];
    const targetValue = target[key];
    if (sourceValue && typeof sourceValue === 'object' && !Array.isArray(sourceValue) && targetValue && typeof targetValue === 'object' && !Array.isArray(targetValue)) {
      result[key] = deepMerge(targetValue as any, sourceValue as any);
    } else if (sourceValue !== undefined) {
      result[key] = sourceValue as T[keyof T];
    }
  }
  return result;
}
