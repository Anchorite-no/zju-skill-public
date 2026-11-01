/** 保留平台字段，调用方可以按自己的任务组合与分析。 */
export interface Semester { id: number; name: string; is_active?: boolean; code?: string; [key: string]: unknown }
export interface Course { id: number; name: string; course_code?: string; semester?: Semester; instructors?: { id: number; name: string }[]; [key: string]: unknown }
export interface Syllabus { id: number; name: string; sort?: number; [key: string]: unknown }
export interface CourseModule { id: number; name: string; sort?: number; syllabuses: Syllabus[]; [key: string]: unknown }
export interface Upload {
  id: number; name: string; size: number; type?: string; link?: string | null;
  [key: string]: unknown;
}
export interface Activity {
  id: number; course_id: number; title: string; type: string; module_id?: number | null; syllabus_id?: number | null;
  sort?: number; uploads: Upload[]; data: Record<string, unknown>; submitted?: boolean;
  published?: boolean; is_closed?: boolean; submit_by_group?: boolean; end_time?: string | null; start_time?: string | null;
  [key: string]: unknown;
}
export interface Submission {
  id: number; is_draft: boolean; uploads: Upload[]; comment?: string; submitted_at?: string | null; can_retract?: boolean;
  [key: string]: unknown;
}
export interface Todo {
  id: number; title: string; course_id: number; course_name?: string; type: string; end_time?: string | null;
  [key: string]: unknown;
}
export interface Page<T> { items: T[]; page: number; pageSize: number; pages: number; total: number }
export interface JournalEvent { at: string; action: string; stage: string; detail: Record<string, unknown> }
export type Journal = (event: JournalEvent) => void | Promise<void>;
export interface WriteOptions { confirm: boolean; journal: Journal }
