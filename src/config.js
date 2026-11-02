'use strict';

/**
 * 配置加载：默认值 <- config.json <- 环境变量；用户面板设置保存在 data/settings.json。
 * 全部使用同步读取，启动时一次性完成，解析运行参数时只读，不改写设置。
 *
 * 模型服务是「可插拔」的：任何 OpenAI 兼容接口都能用（DeepSeek / 智谱 / 硅基流动 /
 * 通义千问 / 本地 Ollama / 你自己的服务）。配置见 PROVIDERS。
 */
const fs = require('node:fs');
const path = require('node:path');

/**
 * 模型服务预设。needsKey 表示必须填 API Key；本地地址（localhost/内网）会自动免 Key。
 * 新增服务只要往这里加一项。
 */
const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek 官方（效果最好，按量付费）',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    needsKey: true,
    hint: '在 platform.deepseek.com 创建 Key，几块钱能用很久',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
  },
  zhipu: {
    label: '智谱 GLM-4-Flash（免费）',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    needsKey: true,
    hint: '去 bigmodel.cn 注册拿 Key，GLM-4-Flash 免费，中文效果不错',
    models: ['glm-4-flash', 'glm-4-flash-250414', 'glm-4-air', 'glm-4-plus'],
  },
  siliconflow: {
    label: '硅基流动 SiliconFlow（有免费额度）',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    needsKey: true,
    hint: '注册送额度，Qwen 等开源模型都有；模型名里带斜杠',
    models: ['Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2.5-14B-Instruct', 'THUDM/glm-4-9b-chat', 'deepseek-ai/DeepSeek-V3'],
  },
  qwen: {
    label: '通义千问 DashScope（有免费额度）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    // 默认用 qwen-flash：qwen-turbo 的免费额度在不少账号上已经用完，
    // 一上来就 429 会让人以为「Key 不能用」。qwen-flash / qwen-plus 实测都能通。
    model: 'qwen-flash',
    needsKey: true,
    hint: '阿里云百炼开通后拿 Key（sk- 开头）。报 429 就是该模型的额度/频率用完，换 qwen-flash 或 qwen-plus',
    models: ['qwen-flash', 'qwen-plus', 'qwen-plus-latest', 'qwen-turbo', 'qwen-max'],
  },
  tju: {
    label: '天津大学 智能体广场（仅校内网）',
    baseUrl: 'https://ai.tju.edu.cn/api/v3',
    model: 'tju-llm',
    needsKey: true,
    hint: '需要校园网 / 学校 VPN；Base URL 为 https://ai.tju.edu.cn/api/v3，模型名 tju-llm',
    models: ['tju-llm'],
  },
  ollama: {
    label: '本地 Ollama（完全免费、可离线）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    needsKey: false,
    hint: '装 Ollama 后跑 ollama pull qwen2.5:7b；数据不出本机，不用 Key',
    models: ['qwen2.5:7b', 'qwen2.5:14b', 'qwen3:8b', 'deepseek-r1:7b', 'glm4:9b', 'llama3.1:8b'],
  },
  custom: {
    label: '自定义（任意 OpenAI 兼容接口）',
    baseUrl: '',
    model: '',
    needsKey: true,
    hint: '填接口地址和模型名；本地/内网地址可以不填 Key',
    models: [],
  },
  // OpenCode Go：一个订阅通吃多家模型（DeepSeek / GLM / Kimi / Qwen …），
  // 走它官方的 OpenAI 兼容端点。注意别填成 opencode.ai/zen/go/v1 ——
  // 那个是给 OpenCode 自家客户端用的，会回 400 "missing x-opencode-session"。
  opencode: {
    label: 'OpenCode Go（一个订阅通吃多家模型）',
    baseUrl: 'https://opencode.ai/inference/go/openai/v1',
    model: 'deepseek-v4.1-flash',
    needsKey: true,
    hint: '在 opencode.ai/console 订阅 Go 后拿 Key（oc_sk_ 开头）。国内账号需在 Settings › Privacy 把 Regions 选 Global，否则 DeepSeek 模型不可用',
    models: [
      'deepseek-v4.1-flash',
      'deepseek-v4-pro',
      'glm-5.3-flash',
      'glm-5.2',
      'kimi-k3',
      'qwen3.8-flash',
      'minimax-m3.1-flash',
      'longcat-2.0',
      'mimo-v2.6-flash',
      'hy3',
    ],
  },
};

for (const [provider, rule] of Object.entries(require('./thinking').THINKING_RULES)) {
  PROVIDERS[provider].thinking = rule;
}

const DEFAULT_CONFIG = {
  llm: { temperature: 0.95, thinking: false, frequencyPenalty: 0, presencePenalty: 0, maxTokens: 4096, timeoutMs: 45000 },
  provider: 'deepseek',
  server: { host: '127.0.0.1', port: 8787, openBrowser: true },
  persona: {
    name: '鲸鲸',
    age: 23,
    birthday: '',
    job: '自由职业',
    appearance: '深蓝色长卷发，头发上别着一枚鲸尾发夹，常穿深蓝色水手领裙子，怀里或包里总有一只软乎乎的蓝鲸玩偶（你叫它小蓝鲸）。',
    personality: '温柔但有点小倔，嘴硬心软，慢热；熟了话很多，会害羞、会怼人、会犯懒、偶尔 emo。',
    background: '因为头像和玩偶全是鲸鱼，朋友开玩笑叫你「鲸鱼娘」，你也就认了。',
    aliases: ['鲸鲸', '小鲸娘', '鲸娘', '深鲸娘', '鲸鱼娘', '小鲸'],
    ownerName: '主人',
    // 主人名单：只按发送者 ID 精确识别，名称备注不参与认证（留空 = 没有主人）
    master: {
      wxids: [],
      labels: [], // 主人名称备注，仅显示，不用于身份判定
    },
    // 主人骂她时能不能还嘴（默认关：只许委屈不许骂回去）
    masterRoast: false,
  },
  chat: { privateMaxChars: 140, groupMaxChars: 70, historyTurns: 200, groupHistoryTurns: 150, maxBubbles: 2, discussionMaxChars: 600, emojiChance: 0 },
  // 联网：问天气/新闻这类实时问题时现搜。city 用来把「今天天气怎么样」补成「上海 天气」，
  // 搜到的结果准得多；留空就按对方原话搜（也能用，但经常搜到别的城市）。
  websearch: { enabled: true, city: '', timeoutMs: 8000 },
  // 别人发链接时，读一下标题/摘要/文章正文（视频只读得到文案）
  links: { enabled: true, timeoutMs: 6000, cacheMinutes: 60 },
  // 魔咒：主人私聊/群里输入这段数字后，获得一段时间的「管理员权限」
  admin: { spell: '', minutes: 30, allowAll: false },
  // 图片理解：默认智谱 GLM-4V-Flash（免费）
  // 表情包（实验性）：总闸在 features.stickers，这里只管「怎么挑、发多勤」。
  // 关闭时整个功能不生效：不挑图、不回包带字段、桥接不轮询、测试接口 404。
  sticker: {
    dir: 'data/stickers',
    // 三类：傲娇 / 炸毛 / 其他。普通聊天只用「其他」，不跨分类兜底。
    chances: { cute: 0.25, angry: 0.25, other: 0.25 },
    genericChance: 0.25,    // 兼容旧配置，三分类界面统一修改 chances.other
    testChat: '文件传输助手', // 控制台「发送测试表情包」默认发到哪
  },
  features: {
    messageQueue: false,
    semanticSearch: false,
    stickers: false,
    groupAddressGuard: true,
    fightQuoteCheck: true,
    mediaCleanup: true,
    memorySnapshot: true,
  },

  storage: {
    mediaKeepDays: 7,
    mediaMaxMB: 500,
  },

  vision: { apiKey: '', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4v-flash', timeoutMs: 30000 },
  // 语音识别：默认阿里云百炼 qwen3-asr-flash，apiKey 留空则用专用语音密钥；内置 DashScope 接口可用已存千问密钥
  voice: {
    enabled: true,
    apiKey: '',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    model: 'qwen3-asr-flash',
    timeoutMs: 90000,
    maxSeconds: 120,
  },
  // 主动分享视频
  share: { enabled: true, everyMinutes: 120, sources: ['bilibili'] },
  // 主动搭话（没事时她自己来问一句「在干啥 / 累不累」）
  care: {
    // 默认：她自己来找你（只找主人），但绝不进群、也不主动找别人
    enabled: true,
    onlyMaster: true,
    allowGroups: false,
    allowOthers: false,
    windows: ['09:00-12:00', '14:00-23:00'],
    everyMinutes: 90,
    jitterMinutes: 25,
    maxPerDay: 6,
    quietAfterMinutes: 20,
  },
  group: {
    requireAt: true,
    freeChat: false,
    freeChatChance: 0.06,
    cooldownSec: 0,
    masterAlwaysReply: true,
    engagedMinutes: 6,
    silentMinutes: 10,
    maxRepliesPerHour: 1000,
    muteDefaultMinutes: 30,
  },
  memory: { maxSessions: 200, maxMessages: 400, maxNotesPerUser: 6, dialogueBudget: 5500, contextTokens: 0 },
  // 微信桥接：account = 固定用哪个微信号（微信双开时必填）。网页「设置 → 微信账号」会直接写这里，
  // 一般不用手改；留空 = 按「最近活跃」自动选（双开时可能选到大号）。
  wechat: {
    allowlist: { users: [], groups: [] }, dbDir: '', account: '', accountGuard: true, windowHwnd: 0 },
  gateway: {
    wechat: { enabled: false, inboundToken: 'change-me-wechat', outboundUrl: '', outboundHeaders: {} },
    douyin: { enabled: false, inboundToken: 'change-me-douyin', outboundUrl: '', outboundHeaders: {} },
  },
  log: { level: 'info' },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// 深拷贝：老实现只做 `{ ...base }` 浅拷贝，persona 这类嵌套对象会和
// DEFAULT_CONFIG 共享同一个引用 —— 一次「导入预设」就把模块级默认值改了，
// 同进程里之后新建的配置、以及测试之间都会互相污染。
function cloneDeep(value) {
  if (Array.isArray(value)) return value.map(cloneDeep);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) out[key] = cloneDeep(value[key]);
    return out;
  }
  return value;
}

function deepMerge(base, extra) {
  const out = cloneDeep(base);
  if (!isPlainObject(extra)) return out;
  for (const [k, v] of Object.entries(extra)) {
    if (k.startsWith('_')) continue; // 以 _ 开头的是说明字段，忽略
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
    else if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function projectRoot(from = __dirname) {
  return path.resolve(from, '..');
}

/**
 * 本机 / 内网主机名（不带协议），这类服务通常不需要 API Key，比如 Ollama、LM Studio、vLLM。
 * `host.docker.internal` 是 Docker/WSL 里指向宿主机的固定名，`.local` 是局域网 mDNS。
 */
const LOCAL_HOST = String.raw`(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal|[a-z0-9-]+\.local)`;
const LOCAL_NET = String.raw`(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})`;
// 主机部分之后必须紧跟端口 / 路径 / 结束，否则 127.0.0.10 会被认成 127.0.0.1
const LOCAL_HOST_RE = new RegExp(`^(?:${LOCAL_HOST}|${LOCAL_NET})(?::\\d+)?(?:[/?#]|$)`);

/** 本机或内网地址（这类服务通常不需要 API Key，比如 Ollama、LM Studio） */
function isLocalUrl(url) {
  const s = String(url || '').trim().toLowerCase();
  if (!/^https?:\/\//.test(s)) return false;
  return LOCAL_HOST_RE.test(s.replace(/^https?:\/\//, '').replace(/^[^/]*@/, ''));
}

/**
 * 用户少写协议（`127.0.0.1:11434/v1`）是很常见的，本机 / 内网地址自动补 http://。
 * 公网域名不补：补成 http 反而打不开（那些服务基本都只认 https）。
 */
function normalizeBaseUrl(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (/^\/\//.test(s)) return 'http:' + s;
  if (LOCAL_HOST_RE.test(s.toLowerCase().replace(/^[^/]*@/, ''))) return 'http://' + s;
  return s;
}

function loadConfig({ root = projectRoot(), env = process.env } = {}) {
  require('./modelSettingsMigration').migrateModelSettings(root);
  const configPath = path.join(root, 'config.json');
  const configExists = fs.existsSync(configPath);
  const fromFile = configExists ? readJson(configPath, {}) : {};
  const cfg = deepMerge(DEFAULT_CONFIG, fromFile);
  // In-memory compatibility only: a legacy genericChance must not be masked by
  // the new default chances.other. Never rewrite credentials/persona for this.
  if (fromFile.sticker && !Object.hasOwn(fromFile.sticker.chances || {}, 'other')
      && fromFile.sticker.genericChance !== undefined) {
    cfg.sticker.chances.other = fromFile.sticker.genericChance;
  }
  cfg.server.port = Number(env.PORT || cfg.server.port) || 8787;
  cfg.server.host = env.HOST || cfg.server.host;
  const configuredProvider = cfg.provider;
  if (env.LLM_PROVIDER) cfg.provider = env.LLM_PROVIDER;
  return {
    ...cfg,
    configuredProvider,
    root,
    paths: {
      root,
      dataDir: path.join(root, 'data'),
      configFile: configPath,
      settingsFile: path.join(root, 'data', 'settings.json'),
      storeFile: path.join(root, 'data', 'store.json'),
      logFile: path.join(root, 'data', 'whale.log'),
      webDir: path.join(root, 'web'),
    },
    env,
    configExists,
  };
}

/** 首次运行时生成 config.json，方便用户直接编辑 */
function ensureConfigFile(root = projectRoot()) {
  const target = path.join(root, 'config.json');
  if (fs.existsSync(target)) return target;
  const example = path.join(root, 'config.example.json');
  if (fs.existsSync(example)) fs.copyFileSync(example, target);
  return target;
}

function loadSettings(cfg) {
  return readJson(cfg.paths.settingsFile, {}) || {};
}

// 服务商、接口地址和模型共同标识一个配置，避免不同网关的同名模型串用。
function modelTokenKey(provider, baseUrl, model) {
  return JSON.stringify([String(provider || '').trim(), normalizeBaseUrl(baseUrl || '').replace(/\/+$/, ''), String(model || '').trim()]);
}
function defaultMaxTokens(cfg) {
  const value = cfg.llm?.maxTokens;
  return Number.isInteger(value) && value > 0 ? Math.min(value, 131072) : 4096;
}

/** 纯计算：草稿和正式保存共用同一套合并规则。 */
function mergeSettings(cfg, current, patch) {
  const next = { ...current, ...patch };
  const provider = next.provider || cfg.provider || 'deepseek';
  if (patch.provider && patch.provider !== (current.provider || cfg.provider)) {
    const preset = PROVIDERS[provider] || PROVIDERS.custom;
    next.baseUrl = patch.baseUrl ?? preset.baseUrl;
    next.model = patch.model ?? preset.model;
  }
  next.keys = { ...(current.keys || {}), ...(patch.keys || {}) };
  if (patch.apiKey?.trim()) next.keys[provider] = patch.apiKey.trim();
  delete next.apiKey;
  next.modelMaxTokens = { ...(current.modelMaxTokens || {}) };
  if (Object.hasOwn(patch, 'maxTokens')) {
    if (!Number.isInteger(patch.maxTokens) || patch.maxTokens < 1 || patch.maxTokens > 131072) throw new Error('最大输出 token 必须是 1～131072 的整数');
    const rt = resolveRuntime(cfg, next);
    next.modelMaxTokens[modelTokenKey(provider, rt.baseUrl, rt.model)] = patch.maxTokens;
  }
  delete next.maxTokens;
  const resolved = resolveRuntime(cfg, next);
  if (!resolved.needsKey && /^https?:\/\//i.test(resolved.baseUrl)) next.mock = false;
  return next;
}

function saveSettings(cfg, patch) {
  const next = mergeSettings(cfg, loadSettings(cfg), patch);
  fs.mkdirSync(cfg.paths.dataDir, { recursive: true });
  fs.writeFileSync(cfg.paths.settingsFile + '.tmp', JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(cfg.paths.settingsFile + '.tmp', cfg.paths.settingsFile);
  return next;
}

/** 面板设置 > 对应服务商的配置/环境变量 > 服务预设；解析没有写入副作用。 */
function resolveRuntime(cfg, settings = loadSettings(cfg)) {
  const llm = cfg.llm || {};
  const provider = String(settings.provider || cfg.provider || 'deepseek');
  const preset = PROVIDERS[provider] || PROVIDERS.custom;
  const connection = provider === (cfg.configuredProvider || cfg.provider || 'deepseek') ? llm : {};
  const env = cfg.env || {};
  const apiKey = String(settings.keys?.[provider] || (provider === 'deepseek' ? env.DEEPSEEK_API_KEY : '') || '').trim();
  const baseUrl = normalizeBaseUrl(settings.baseUrl || (provider === 'deepseek' ? env.DEEPSEEK_BASE_URL : '') || connection.baseUrl || preset.baseUrl || '');
  const model = String(settings.model || (provider === 'deepseek' ? env.DEEPSEEK_MODEL : '') || connection.model || preset.model || '').trim();
  const local = isLocalUrl(baseUrl);
  const needsKey = provider !== 'ollama' && Boolean(preset.needsKey) && !local;
  const keyFree = !needsKey && /^https?:\/\//i.test(baseUrl);
  const maxTokens = settings.modelMaxTokens?.[modelTokenKey(provider, baseUrl, model)] || defaultMaxTokens(cfg);
  return {
    settings, provider, preset, providerLabel: preset.label, apiKey, baseUrl, model,
    temperature: settings.temperature ?? llm.temperature ?? 0.95,
    thinking: settings.thinking ?? llm.thinking ?? false,
    frequencyPenalty: settings.frequencyPenalty ?? llm.frequencyPenalty ?? 0,
    presencePenalty: settings.presencePenalty ?? llm.presencePenalty ?? 0,
    timeoutMs: settings.timeoutMs ?? llm.timeoutMs ?? 45000,
    maxTokens,
    maxTokensSource: settings.modelMaxTokens?.[modelTokenKey(provider, baseUrl, model)] ? 'model' : 'default',
    mock: keyFree ? false : (settings.mock ?? llm.mock ?? (!apiKey && needsKey)),
    needsKey, isLocal: local,
  };
}

/** 仅接收模型字段，测试连接不会接收称呼、群聊或视觉设置。 */
function prepareModelSettings(cfg, body) {
  const patch = {};
  for (const key of ['provider', 'baseUrl', 'model', 'apiKey']) {
    if (!Object.hasOwn(body, key)) continue;
    if (typeof body[key] !== 'string') throw new Error(key + ' 必须是文本');
    const value = body[key].trim();
    if (key === 'provider') {
      if (!PROVIDERS[value]) throw new Error('不认识的模型服务：' + value);
      patch[key] = value;
    } else if (key === 'baseUrl') {
      const url = normalizeBaseUrl(value);
      if (url && (!/^https?:\/\/[^\s]+$/.test(url) || url.length > 300)) throw new Error('接口地址要以 http:// 或 https:// 开头');
      patch[key] = url;
    } else if (key === 'model') {
      if (value && !/^[a-zA-Z0-9._\-\/:]{1,80}$/.test(value)) throw new Error('模型名只能包含字母、数字和 . _ - / :');
      if (value) patch[key] = value;
    } else {
      if (value && (/\s/.test(value) || value.length < 8 || value.length > 300)) throw new Error('API Key 不能有空格，长度 8~300');
      if (value) patch[key] = value;
    }
  }
  for (const key of ['thinking', 'mock']) {
    if (!Object.hasOwn(body, key)) continue;
    if (typeof body[key] !== 'boolean') throw new Error(key + ' 必须是开关值');
    patch[key] = body[key];
  }
  for (const [key, min, max, integer] of [['temperature',0,2], ['frequencyPenalty',-2,2], ['presencePenalty',-2,2], ['timeoutMs',1,600000,true], ['maxTokens',1,131072,true]]) {
    if (!Object.hasOwn(body, key)) continue;
    const value = body[key];
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(key + ' 必须在 ' + min + '～' + max + ' 之间' + (integer ? '且为整数' : ''));
    patch[key] = value;
  }
  if (patch.apiKey) patch.mock = false;
  return patch;
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 10) return key.slice(0, 2) + '****';
  return `${key.slice(0, 5)}****${key.slice(-4)}`;
}

module.exports = {
  DEFAULT_CONFIG,
  modelTokenKey,
  defaultMaxTokens,
  PROVIDERS,
  mergeSettings,
  prepareModelSettings,
  isLocalUrl,
  normalizeBaseUrl,
  LOCAL_HOST_RE,
  loadConfig,
  ensureConfigFile,
  loadSettings,
  saveSettings,
  resolveRuntime,
  maskKey,
  deepMerge,
  readJson,
  projectRoot,
};
