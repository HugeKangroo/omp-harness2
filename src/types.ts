/** Versioned wire/storage contracts. Never persist executable objects or secrets. */
export type Mode = "product" | "research";
export type StageId = "baseline" | "inv_edit" | "dom_edit" | "inv_probe" | "dom_probe" | "compose_edit" | "final" | "select" | "reflect";
export type RunStatus = "queued" | "running" | "interrupted" | "completed" | "failed" | "cancelled" | "applied";

export interface HarnessSkill { name: string; description: string; content: string }
export interface HarnessBundle {
  schemaVersion: 1;
  id: string;
  parentId?: string;
  promptAppend: string;
  toolGuidance: string;
  skills: HarnessSkill[];
  rationale: string;
}

export interface RunConfig {
  mode: Mode;
  model: string;
  improverModel: string;
  maxCostUsd: number;
  maxDurationMs: number;
  stageTimeoutMs: number;
  domain: string;
  ompCommand: string;
}

export interface FileEntry { path: string; hash: string; size: number; mode: number }
export interface WorkspaceSnapshot {
  id: string;
  sourceRoot: string;
  root: string;
  files: FileEntry[];
  createdAt: string;
  excludedPaths?: string[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface WorkerRequest {
  runId: string;
  stage: StageId;
  role: "solver" | "editor" | "selector" | "reflector";
  cwd: string;
  artifactDir: string;
  prompt: string;
  harness: HarnessBundle;
  model: string;
  maxCostUsd: number;
  timeoutMs: number;
  ompCommand: string;
  signal?: AbortSignal;
  onEvent?: (event: WorkerEvent) => void;
}

export interface WorkerEvent { type: string; timestamp: string; data: unknown }
export interface WorkerResult {
  text: string;
  usage: Usage;
  startedAt: string;
  endedAt: string;
  eventsPath: string;
  status: "completed" | "failed" | "cancelled" | "timed_out";
  error?: string;
  /** True when cost is a conservative allocation reservation, not observed provider usage. */
  usageEstimated?: boolean;
}
export interface Runner { run(request: WorkerRequest): Promise<WorkerResult> }

export interface StageRecord {
  id: StageId;
  status: "running" | "completed" | "failed";
  attempt: number;
  cwd: string;
  startedAt: string;
  endedAt?: string;
  result?: WorkerResult;
  harness?: HarnessBundle;
  error?: string;
  /** Total consumed/reserved USD across attempts; interrupted attempts retain reservation. */
  accountedCostUsd?: number;
  reservedCostUsd?: number;
  /** Hash of the admitted file-change manifest, pinned before composition/selection. */
  artifactHash?: string;
  traceHash?: string;
  validationFailures?: number;
  observedCostUsd?: number;
}

export interface Lesson {
  cue: string;
  lesson: string;
  evidence: string[];
  confidence: "low" | "medium" | "high";
  limitations: string;
}
export interface LibraryEntry {
  schemaVersion: 1;
  id: string;
  runId: string;
  domain: string;
  model: string;
  createdAt: string;
  harness: HarnessBundle;
  lesson: Lesson;
}

export interface RunRecord {
  schemaVersion: 1;
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  workspace: string;
  task: string;
  config: RunConfig;
  status: RunStatus;
  snapshot?: WorkspaceSnapshot;
  baseHarness: HarnessBundle;
  libraryEntries: LibraryEntry[];
  stages: Partial<Record<StageId, StageRecord>>;
  winner?: "baseline" | "final";
  selectionReason?: string;
  lesson?: Lesson;
  error?: string;
  appliedAt?: string;
  warnings?: string[];
}

export interface RunEvent {
  schemaVersion: 1;
  runId: string;
  timestamp: string;
  type: string;
  stage?: StageId;
  message: string;
}

export interface Change {
  path: string;
  kind: "add" | "modify" | "delete";
  beforeHash?: string;
  afterHash?: string;
}
export interface ApplyResult { applied: boolean; changes: Change[]; alreadyApplied: boolean }
