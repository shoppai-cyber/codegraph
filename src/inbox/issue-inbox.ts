import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const ISSUE_INBOX_SCHEMA_VERSION = 1 as const;
export const ISSUE_INBOX_ATTRIBUTION_CLASSES = [
  'codegraph',
  'origin-repo',
  'environment',
  'unknown',
] as const;

export type IssueAttributionClass = (typeof ISSUE_INBOX_ATTRIBUTION_CLASSES)[number];

export interface IssueReport {
  schemaVersion: 1;
  title: string;
  originRepo: string;
  codegraphVersion: string;
  indexSchemaVersion: number;
  command: string;
  filePath: string;
  fileHash: string;
  expectedBehavior: string;
  actualBehavior: string;
  attributionClass: IssueAttributionClass;
  evidencePointer: string;
}

export interface FiledIssueReport {
  reportId: string;
  reportPath: string;
  duplicate: boolean;
}

export interface IssueInboxSummaryReport {
  reportId: string;
  title: string;
  originRepo: string;
  filePath: string;
  attributionClass: IssueAttributionClass;
  reportPath: string;
}

export interface IssueInboxSummary {
  carrier: string;
  reportCount: number;
  reports: IssueInboxSummaryReport[];
}

export interface FileIssueReportOptions {
  carrierDir?: string;
  productRoot?: string;
}

const ISSUE_REPORT_FIELDS = [
  'schemaVersion',
  'title',
  'originRepo',
  'codegraphVersion',
  'indexSchemaVersion',
  'command',
  'filePath',
  'fileHash',
  'expectedBehavior',
  'actualBehavior',
  'attributionClass',
  'evidencePointer',
] as const satisfies readonly (keyof IssueReport)[];

const ISSUE_REPORT_FIELD_SET = new Set<string>(ISSUE_REPORT_FIELDS);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_TITLE_LENGTH = 200;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function invalidReport(errors: string[]): never {
  throw new Error(`Invalid issue report: ${errors.join('; ')}`);
}

/** Validate the closed, input-facing issue report schema without touching disk. */
export function validateIssueReport(value: unknown): IssueReport {
  if (!isPlainObject(value)) {
    return invalidReport(['report must be a JSON object']);
  }

  const errors: string[] = [];
  for (const key of Object.keys(value)) {
    if (!ISSUE_REPORT_FIELD_SET.has(key)) errors.push(`unknown field "${key}"`);
  }

  for (const field of ISSUE_REPORT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      errors.push(`${field} is required`);
    }
  }

  if (value.schemaVersion !== ISSUE_INBOX_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${ISSUE_INBOX_SCHEMA_VERSION}`);
  }

  for (const field of ['title', 'originRepo', 'codegraphVersion', 'command', 'filePath', 'fileHash', 'expectedBehavior', 'actualBehavior', 'evidencePointer'] as const) {
    if (Object.prototype.hasOwnProperty.call(value, field) && !isNonEmptyString(value[field])) {
      errors.push(`${field} must be a non-empty string`);
    }
  }

  if (typeof value.title === 'string' && value.title.trim().length > MAX_TITLE_LENGTH) {
    errors.push(`title must be at most ${MAX_TITLE_LENGTH} characters`);
  }

  if (!Number.isInteger(value.indexSchemaVersion) || (value.indexSchemaVersion as number) <= 0) {
    errors.push('indexSchemaVersion must be a positive integer');
  }

  if (typeof value.originRepo === 'string' && !path.isAbsolute(value.originRepo)) {
    errors.push('originRepo must be an absolute path');
  }

  if (typeof value.filePath === 'string' && !path.isAbsolute(value.filePath)) {
    errors.push('filePath must be an absolute path');
  }

  if (typeof value.fileHash === 'string' && !SHA256_PATTERN.test(value.fileHash)) {
    errors.push('fileHash must be a lowercase SHA-256 hash');
  }

  if (!isNonEmptyString(value.attributionClass) || !ISSUE_INBOX_ATTRIBUTION_CLASSES.includes(value.attributionClass as IssueAttributionClass)) {
    errors.push(`attributionClass must be one of: ${ISSUE_INBOX_ATTRIBUTION_CLASSES.join(', ')}`);
  }

  if (errors.length > 0) return invalidReport(errors);

  return {
    schemaVersion: ISSUE_INBOX_SCHEMA_VERSION,
    title: value.title as string,
    originRepo: value.originRepo as string,
    codegraphVersion: value.codegraphVersion as string,
    indexSchemaVersion: value.indexSchemaVersion as number,
    command: value.command as string,
    filePath: value.filePath as string,
    fileHash: value.fileHash as string,
    expectedBehavior: value.expectedBehavior as string,
    actualBehavior: value.actualBehavior as string,
    attributionClass: value.attributionClass as IssueAttributionClass,
    evidencePointer: value.evidencePointer as string,
  };
}

/**
 * Resolve the user-owned carrier. The override is intentionally absolute so a
 * test or operator cannot accidentally redirect reports into the current repo.
 */
export function getIssueInboxDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
): string {
  const configured = env.CODEGRAPH_ISSUE_INBOX_DIR?.trim();
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new Error('CODEGRAPH_ISSUE_INBOX_DIR must be an absolute path');
    }
    return path.resolve(configured);
  }

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim() || path.join(home, 'AppData', 'Local');
    return path.resolve(localAppData, 'CodeGraph', 'issue-inbox');
  }
  if (platform === 'darwin') {
    return path.resolve(home, 'Library', 'Application Support', 'CodeGraph', 'issue-inbox');
  }
  const stateHome = env.XDG_STATE_HOME?.trim() || path.join(home, '.local', 'state');
  return path.resolve(stateHome, 'codegraph', 'issue-inbox');
}

function readInputReport(inputPath: string): IssueReport {
  if (!path.isAbsolute(inputPath)) {
    throw new Error('input path must be an absolute path');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(inputPath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`could not read input JSON ${inputPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const report = validateIssueReport(parsed);
  let originStats: fs.Stats;
  try {
    originStats = fs.statSync(report.originRepo);
  } catch (error) {
    throw new Error(`originRepo does not exist or cannot be read: ${report.originRepo} (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!originStats.isDirectory()) {
    throw new Error(`originRepo is not a directory: ${report.originRepo}`);
  }

  let sourceStats: fs.Stats;
  try {
    sourceStats = fs.statSync(report.filePath);
  } catch {
    throw new Error(`filePath does not exist or is not a regular file: ${report.filePath}`);
  }
  if (!sourceStats.isFile()) {
    throw new Error(`filePath does not exist or is not a regular file: ${report.filePath}`);
  }

  let actualHash: string;
  try {
    actualHash = crypto.createHash('sha256').update(fs.readFileSync(report.filePath)).digest('hex');
  } catch (error) {
    throw new Error(`filePath could not be read: ${report.filePath} (${error instanceof Error ? error.message : String(error)})`);
  }
  if (actualHash !== report.fileHash) {
    throw new Error(`fileHash does not match filePath: expected ${report.fileHash}, actual ${actualHash}`);
  }

  return report;
}

function canonicalReport(report: IssueReport): string {
  const ordered: Record<string, unknown> = {};
  for (const field of ISSUE_REPORT_FIELDS) ordered[field] = report[field];
  return JSON.stringify(ordered);
}

function reportId(report: IssueReport): string {
  return crypto.createHash('sha256').update(canonicalReport(report), 'utf8').digest('hex');
}

function storedReportText(report: IssueReport, id: string): string {
  return JSON.stringify({ ...report, reportId: id }, null, 2) + '\n';
}

function writeReportAtomically(finalPath: string, body: string): boolean {
  if (fs.existsSync(finalPath)) {
    const existing = fs.readFileSync(finalPath, 'utf8');
    if (existing === body) return false;
    throw new Error(`issue report identity collision at ${finalPath}`);
  }

  const temporaryPath = `${finalPath}.tmp.${process.pid}.${crypto.randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporaryPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.writeFileSync(fd, body, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    try {
      fs.renameSync(temporaryPath, finalPath);
      return true;
    } catch (error) {
      // Another process may have published the same content between the
      // existence check and rename. Treat that race as a duplicate only after
      // reading back the complete atomically-published file.
      if (fs.existsSync(finalPath) && fs.readFileSync(finalPath, 'utf8') === body) return false;
      throw error;
    }
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* preserve the original failure */ }
    }
    try { fs.unlinkSync(temporaryPath); } catch { /* already renamed or absent */ }
  }
}

export function fileIssueReport(inputPath: string, options: FileIssueReportOptions = {}): FiledIssueReport {
  const report = readInputReport(inputPath);
  const carrier = path.resolve(options.carrierDir ?? getIssueInboxDir());
  const originRepo = path.resolve(report.originRepo);
  if (isWithin(carrier, originRepo)) {
    throw new Error(`issue inbox carrier must be outside originRepo: ${carrier}`);
  }
  if (options.productRoot && isWithin(carrier, path.resolve(options.productRoot))) {
    throw new Error(`issue inbox carrier must be outside the CodeGraph product checkout: ${carrier}`);
  }

  const reportsDir = path.join(carrier, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const id = reportId(report);
  const reportPath = path.join(reportsDir, `${id}.json`);
  const published = writeReportAtomically(reportPath, storedReportText(report, id));
  return { reportId: id, reportPath: path.resolve(reportPath), duplicate: !published };
}

function readStoredReport(filePath: string): IssueReport & { reportId: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`stored issue report is not valid JSON: ${filePath} (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!isPlainObject(parsed) || typeof parsed.reportId !== 'string') {
    throw new Error(`stored issue report has no reportId: ${filePath}`);
  }
  const { reportId: id, ...reportValue } = parsed;
  const report = validateIssueReport(reportValue);
  const expectedId = reportId(report);
  if (id !== expectedId) {
    throw new Error(`stored issue report id does not match its content: ${filePath}`);
  }
  return { ...report, reportId: id };
}

export function summarizeIssueInbox(carrierDir = getIssueInboxDir()): IssueInboxSummary {
  const carrier = path.resolve(carrierDir);
  const reportsDir = path.join(carrier, 'reports');
  if (!fs.existsSync(reportsDir)) return { carrier, reportCount: 0, reports: [] };

  const names = fs.readdirSync(reportsDir).filter((name) => name.endsWith('.json')).sort();
  const reports = names.map((name) => {
    const reportPath = path.resolve(reportsDir, name);
    const report = readStoredReport(reportPath);
    return {
      reportId: report.reportId,
      title: report.title,
      originRepo: report.originRepo,
      filePath: report.filePath,
      attributionClass: report.attributionClass,
      reportPath,
    };
  });

  return { carrier, reportCount: reports.length, reports };
}
