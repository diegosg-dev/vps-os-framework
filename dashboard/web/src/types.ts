export interface DiskMetricsView {
  mountPath: string;
  totalMb: number;
  usedMb: number;
  usagePercent: number;
}

export interface SystemMetricsView {
  hostname: string;
  cpuCount: number;
  loadAverage1m: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
  memoryUsagePercent: number;
  uptimeSeconds: number;
  collectedAt: string;
  disk?: DiskMetricsView;
}

export interface AppCardView {
  slug: string;
  name: string;
  kind: "web-app" | "personal-agent";
  domain: string | null;
  status: string;
  cpuLimit: string;
  memoryLimitMb: number;
}

export interface AuditEventView {
  id: string;
  actor: "user" | "agent" | "system";
  action: string;
  targetSlug: string | null;
  summary: string;
  riskLevel: "low" | "medium" | "high";
  createdAt: string;
}

export interface PlanStepView {
  id: string;
  title: string;
  description: string;
  toolName?: string;
  riskLevel: "low" | "medium" | "high";
  requiresApproval: boolean;
  args?: Record<string, unknown>;
}

export interface ExecutionPlanView {
  id: string;
  goal: string;
  summary: string;
  requiresUserApproval: boolean;
  status?: "pending" | "approved" | "rejected" | "executed";
  decidedBy?: string | null;
  decidedAt?: string | null;
  createdAt?: string;
  steps: PlanStepView[];
}

export type LlmProviderId =
  | "opencode"
  | "openai"
  | "anthropic"
  | "openrouter"
  | "nous"
  | "ollama";

export type OnboardingStepId =
  | "domain"
  | "provider"
  | "persona"
  | "scan"
  | "complete";

export interface OnboardingBootStatus {
  onboardingCompleted: boolean;
  currentStep: OnboardingStepId;
  claimAvailable: boolean;
  passphraseConfigured: boolean;
  authRequired: boolean;
}

export interface ProviderEndpointPreset {
  id: string;
  label: string;
  description: string;
  baseUrl: string;
  requiresApiKey: boolean;
  keyLabel?: string;
  keyPlaceholder?: string;
}

export interface ProviderCatalogItem {
  id: LlmProviderId;
  label: string;
  badge?: string;
  description: string;
  defaultModel: string;
  suggestedModels: string[];
  requiresApiKey: boolean;
  keyPlaceholder: string;
  defaultBaseUrl: string;
  endpointPresets?: ProviderEndpointPreset[];
  setupHint?: string;
}

export type ChatMode = "agent" | "plan";

export interface ChatAttachmentView {
  id: string;
  threadId: string | null;
  name: string;
  mimeType: string;
  sizeBytes: number;
  kind: "image" | "text" | "file";
  textPreview: string | null;
  url: string;
  createdAt: string;
  localPreviewUrl?: string;
}

export interface ChatReasoningBlockView {
  id: string;
  title: string;
  content: string;
  durationMs: number;
  status: "streaming" | "done";
}

export interface ChatToolCallView {
  id: string;
  toolName: string;
  label: string;
  status: "running" | "success" | "error" | "awaiting_approval";
  input: Record<string, unknown>;
  output?: unknown;
  error: string | null;
  durationMs: number | null;
  startedAt: string;
  completedAt: string | null;
}

export interface ChatMessageView {
  id: string;
  threadId: string;
  role: "user" | "assistant" | "system";
  content: string;
  attachments: ChatAttachmentView[];
  reasoning: ChatReasoningBlockView[];
  toolCalls: ChatToolCallView[];
  planId: string | null;
  provider: string | null;
  model: string | null;
  status: "streaming" | "completed" | "error";
  createdAt: string;
}

export interface ChatThreadView {
  id: string;
  title: string;
  provider: string | null;
  model: string | null;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface BaselineCheckView {
  id: string;
  label: string;
  status: "ok" | "warn" | "pending";
  detail: string;
}

export interface BaselineScanView {
  scannedAt: string;
  hostname: string;
  osRelease: string;
  cpuCount: number;
  memoryTotalMb: number;
  memoryUsedMb: number;
  diskTotalGb: number | null;
  diskUsedGb: number | null;
  checks: BaselineCheckView[];
  summary: string;
}

export interface OnboardingStateView {
  completed: boolean;
  completedAt: string | null;
  currentStep: OnboardingStepId;
  domainMode: "domain" | "ip-only";
  domain: string | null;
  acmeEmail: string | null;
  publicIp: string | null;
  dnsVerified: boolean;
  llmProvider: LlmProviderId | null;
  llmModel: string | null;
  llmBaseUrl: string | null;
  llmConfigured: boolean;
  telegramConfigured: boolean;
  discordConfigured: boolean;
  persona: {
    ownerName: string;
    technicalLevel: "non-technical" | "developer";
    communicationStyle: "plain-english" | "concise" | "detailed";
    approvalMode: "manual" | "smart";
  };
  baselineScan: BaselineScanView | null;
  updatedAt: string;
}

export interface DnsCheckView {
  domain: string;
  resolvedIps: string[];
  expectedIp: string | null;
  matches: boolean;
  message: string;
}

export interface HermesStatusView {
  reachable: boolean;
  url: string | null;
  detail: string;
}

export interface HostApplyStatusView {
  appliedAt?: string;
  caddyReloaded?: boolean;
  hermesRestarted?: boolean;
  hermesActive?: boolean;
  error?: string;
}

export interface OnboardingPayload {
  state: OnboardingStateView;
  providerCatalog: ProviderCatalogItem[];
  hermesStatus: HermesStatusView;
  hostApplyStatus: HostApplyStatusView | null;
  passphraseConfigured: boolean;
}
