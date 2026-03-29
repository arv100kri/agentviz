/**
 * TypeScript types for fax context bundles (fax-context-bundle/v1).
 */

// --- Polymorphic manifest fields ---

export interface FaxProgressStepObject {
  step: string;
  result?: string;
  priority?: string;
  summary: string;
}

export type FaxProgressStep = string | FaxProgressStepObject;

export interface FaxDoNotRetryObject {
  approach: string;
  reason: string;
}

export type FaxDoNotRetryEntry = string | FaxDoNotRetryObject;

// --- Manifest schema ---

export interface FaxSender {
  alias: string;
  email: string;
  program: string;
  sessionId: string;
}

export interface FaxSharedArtifact {
  label: string;
  type: "file" | "directory";
  bundlePath: string;
}

export interface FaxGitInfo {
  branch: string;
  head: string;
  statusEntries: number;
}

export interface FaxProgress {
  stepsCompleted: FaxProgressStep[];
  stepsRemaining: FaxProgressStep[];
}

export interface FaxManifest {
  schemaVersion: string;
  createdUtc: string;
  bundleLabel?: string;
  threadId: string;
  importance: "normal" | "high" | "urgent";
  sourceRoot: string;
  sender: FaxSender;
  artifacts: string[];
  sharedArtifacts: FaxSharedArtifact[];
  git?: FaxGitInfo;
  progress?: FaxProgress;
  doNotRetry?: FaxDoNotRetryEntry[];
  fileReservations?: string[];
}

// --- Normalized types (for display) ---

export interface NormalizedProgressStep {
  step: string;
  result?: string;
  priority?: string;
  summary: string;
}

export interface NormalizedDoNotRetry {
  approach: string;
  reason: string;
}

export function normalizeProgressStep(item: FaxProgressStep): NormalizedProgressStep {
  if (typeof item === "string") {
    return { step: item, summary: item };
  }
  return {
    step: item.step || item.summary || "",
    result: item.result,
    priority: item.priority,
    summary: item.summary || item.step || "",
  };
}

export function normalizeDoNotRetry(item: FaxDoNotRetryEntry): NormalizedDoNotRetry {
  if (typeof item === "string") {
    return { approach: item, reason: "" };
  }
  return {
    approach: item.approach || "",
    reason: item.reason || "",
  };
}

// --- Fax list entry (returned by /api/faxes) ---

export interface FaxListEntry {
  id: string;
  folderName: string;
  label: string;
  sender: FaxSender;
  importance: "normal" | "high" | "urgent";
  threadId: string;
  createdUtc: string;
  hasEvents: boolean;
  artifactCount: number;
  sharedArtifactCount: number;
  git?: FaxGitInfo;
  progress?: FaxProgress;
  bundlePath: string;
}

// --- Read status ---

export interface FaxReadStatus {
  [folderName: string]: string; // ISO timestamp of when it was read
}

// --- Fax bundle (full loaded bundle) ---

export interface FaxBundle {
  manifest: FaxManifest;
  folderName: string;
  bundlePath: string;
  markdownFiles: { name: string; content: string }[];
  hasEvents: boolean;
}
