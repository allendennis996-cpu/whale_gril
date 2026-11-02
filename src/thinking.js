'use strict';

// 只为已确认支持切换的模型发送参数；网关和未知模型不按名称猜测协议。
const THINKING_RULES = {
  deepseek: { pattern: '^deepseek-(?:flash$|v4(?:[.-]|$)|v3[.-][12](?:$|-))', kind: 'thinking' },
  qwen: { pattern: '^qwen-(?:flash|plus)(?:-latest)?$', kind: 'enable_thinking' },
  zhipu: {
    pattern: '^glm-(?:4\\.[567]|5(?:\\.[012])?)(?:$|-)', kind: 'thinking',
    forced: '^glm-5\\.3(?:$|-)',
  },
  siliconflow: {
    pattern: '^(?:Pro/)?Qwen/Qwen3-(?:8B|14B|32B|30B-A3B|235B-A22B)$', kind: 'enable_thinking',
    forced: '(?:DeepSeek-R1|QwQ-32B|Qwen3-[^/]*-Thinking)',
  },
  ollama: { pattern: '^qwen3(?::|$)', kind: 'reasoning_effort', forced: '^deepseek-r1(?::|$)' },
};

function thinkingCapability(provider, model) {
  const rule = THINKING_RULES[provider];
  if (rule?.forced && new RegExp(rule.forced, 'i').test(model)) return { supported: false, forced: true };
  return { supported: Boolean(rule && new RegExp(rule.pattern, 'i').test(model)), forced: false, kind: rule?.kind };
}

function applyThinking(payload, provider, model, enabled) {
  const capability = thinkingCapability(provider, model);
  if (!capability.supported) return payload;
  if (capability.kind === 'thinking') payload.thinking = { type: enabled ? 'enabled' : 'disabled' };
  if (capability.kind === 'enable_thinking') payload.enable_thinking = enabled;
  if (capability.kind === 'reasoning_effort') payload.reasoning_effort = enabled ? 'medium' : 'none';
  return payload;
}

module.exports = { THINKING_RULES, thinkingCapability, applyThinking };
