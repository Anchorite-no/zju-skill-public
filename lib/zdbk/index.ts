/**
 * 本科教学管理信息服务平台（zdbk.zju.edu.cn）。
 *
 * 声明：auth=cas network=public writes=true（自主选课写闸）。
 * 登录：zjuam.loginService("…/xtgl/login_ssologin.html")。
 * 会话：data/sessions/zdbk.json，TTL 2h；失效自动重登一次。
 *
 * 当前实现：课表、期中/期末考试安排、成绩与绩点、培养方案。通知在 notice 模块，借用这里的会话。
 * 自主选课：查询、志愿提交、排序、直接退选与回查；未实现：补退选申请。
 */
export { ZDBK_HOST, BASE, CAS_SERVICE, MODULE, requirements, XRW, Zdbk, openZdbk, isExpired, stripRow } from "./client.ts";
export type { ZdbkOptions, GridPage } from "./client.ts";
export { getExams, examArrangement } from "./kscx.ts";
export { getGrades } from "./cjcx.ts";
export { listTerms, checkTermOpen, getTimetable, getSchedule, cachedSchedule, parseKcb } from "./kbcx.ts";
export type { Timetable, TimetableRow, TermCode, TermOption } from "./kbcx.ts";
export { listPlans, listMajors, downloadPdf, getMyPlanId, pdfUrl, toPlan } from "./pyfagl.ts";
export type { Plan, PlanRow, Major, ListPlansOptions } from "./pyfagl.ts";
export { Xsxk, parseSelectionContext, preferenceGroup, selectionState, parseCapacity, SEARCH_FIELDS, SEARCH_OPERATORS } from "./xsxk.ts";
export type { SelectionPort, SelectionRow, SelectionContext, Category, SearchOptions, SearchCondition, SectionQuery, SelectionTarget, SelectionWriteOptions, SelectionWriteResult, SelectionJournalEvent } from "./xsxk.ts";
