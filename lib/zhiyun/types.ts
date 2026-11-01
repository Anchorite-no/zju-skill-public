export interface Course {
  id: string;
  title: string;
  teacher: string;
  term: string;
  url: string;
}
export interface Asset {
  kind: "video" | "audio" | "courseware" | "slide";
  name: string;
  url: string;
  seconds?: number;
  height?: number;
}
export interface Lesson {
  lesson: number;
  courseId: string;
  subId: string;
  title: string;
  teacher: string;
  startsAt: string | null;
  status: string;
  playable: boolean;
  url: string;
  assets: Asset[];
}
export interface Caption { start: number; end: number | null; text: string }
export interface Page<T> { items: T[]; page: number; pageSize: number; total: number }
export type JsonObject = Record<string, unknown>;
