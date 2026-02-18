import type { KeyProfile, KeyProfileWithKeys } from '../services/key-profiles.js';

export const sampleKeyProfile: KeyProfile = {
  name: 'dev-profile',
  createdAt: '2024-01-15T10:30:00Z',
  description: 'Development API keys',
  hasClaudeKey: true,
  hasClaudeSetupToken: false,
  hasOpenaiKey: true,
  hasGrokKey: false,
  hasGeminiKey: false,
};

export const sampleKeyProfile2: KeyProfile = {
  name: 'prod-profile',
  createdAt: '2024-02-20T14:00:00Z',
  description: 'Production API keys',
  hasClaudeKey: true,
  hasClaudeSetupToken: false,
  hasOpenaiKey: true,
  hasGrokKey: true,
  hasGeminiKey: true,
};

export const minimalKeyProfile: KeyProfile = {
  name: 'minimal',
  createdAt: '2024-03-01T08:00:00Z',
  hasClaudeKey: false,
  hasClaudeSetupToken: false,
  hasOpenaiKey: false,
  hasGrokKey: false,
  hasGeminiKey: false,
};

export const sampleKeyProfileWithKeys: KeyProfileWithKeys = {
  ...sampleKeyProfile,
  claudeKey: 'sk-ant-test-key-12345',
  openaiKey: 'sk-openai-test-key-67890',
};

export const sampleApiKeys = {
  claude: 'sk-ant-api-test-key-abc123',
  openai: 'sk-openai-test-key-def456',
  grok: 'xai-test-key-ghi789',
  gemini: 'AIza-test-key-jkl012',
};
