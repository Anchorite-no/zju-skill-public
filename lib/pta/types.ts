export const PROBLEM_TYPES = ["TRUE_OR_FALSE", "MULTIPLE_CHOICE", "MULTIPLE_CHOICE_MORE_THAN_ONE_ANSWER", "FILL_IN_THE_BLANK", "FILL_IN_THE_BLANK_FOR_PROGRAMMING", "CODE_COMPLETION", "PROGRAMMING", "SUBJECTIVE", "MULTIPLE_FILE", "SQL_PROGRAMMING", "CHOICE_BLANK"] as const;
export type ProblemType = typeof PROBLEM_TYPES[number];
export const CLUSTERED = new Set<string>(["TRUE_OR_FALSE", "MULTIPLE_CHOICE", "MULTIPLE_CHOICE_MORE_THAN_ONE_ANSWER", "FILL_IN_THE_BLANK", "FILL_IN_THE_BLANK_FOR_PROGRAMMING", "CHOICE_BLANK"]);
export interface ProblemSet {
  id: string; name: string; type: string; timeType: string; startAt: string; endAt: string;
  description?: string;
  problemSetConfig?: { compilers?: string[]; allowSubmitExam?: boolean; omsProtected?: boolean; autoSave?: boolean; [key: string]: unknown };
  [key: string]: unknown;
}
export interface Exam {
  id: string; problemSetId: string; userId: string; status: string; ended: boolean;
  score: number; startAt: string; endAt: string; delayedEndAt?: string;
  [key: string]: unknown;
}
export interface ExamInfo {
  serverTime: string; problemSet: ProblemSet; exam?: Exam; status: string;
  permission: { permission: number }; homework?: unknown;
}
export interface ProblemStatus {
  id: string; label: string; score: number; problemType: string; problemSubmissionStatus: string;
  [key: string]: unknown;
}
export interface Problem {
  id: string; problemSetId: string; type: string; label: string; title: string; content: string;
  description: string; score: number; deadline?: string; compiler?: string;
  problemConfig: Record<string, unknown>;
  [key: string]: unknown;
}
export interface SubmissionDetail { problemId: string; problemSetProblemId: string; [key: string]: unknown }
export interface Submission {
  id: string; userId: string; problemSetId: string; problemType: string;
  submissionDetails?: SubmissionDetail[]; status: string; submitAt: string;
  [key: string]: unknown;
}
/** problemId 在公开输入里指题目集小题 ID（problemSetProblemId），全程使用字符串。 */
export interface AnswerInput {
  problemId: string;
  answer?: string | string[];
  code?: string;
  compiler?: string;
  fileContents?: Record<string, string>;
}
export interface PtaApi {
  readonly username: string;
  get<T>(endpoint: string): Promise<T>;
  mutate<T>(endpoint: string, body: unknown, method?: "POST" | "PUT"): Promise<T>;
}
