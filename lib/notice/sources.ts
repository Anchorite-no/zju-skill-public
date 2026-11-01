/**
 * 来源表。加一个网站群（webplus）站点或栏目只改这里；栏目号取自该栏目列表页地址 /<栏目>/list.htm。
 * 各学院官网不在这里：colleges.json 由 scripts/notice/colleges.ts 生成，按使用者的学院选（identity.ts）。
 * 顺序即合并时的优先级：同一条通知在几个来源都有时留排在前面的那个。
 * default：不指名来源时也读。feed：notice new 的增量扫描读它。两者都没有的栏目只在 --source 指名时读。
 * audience：只面向本科生或研究生的栏目，默认集和增量集里只给对应的使用者。
 */
import type { Source } from "./types.ts";

export const SOURCES: Source[] = [
  { id: "zdbk", name: "教务网", aliases: ["教务", "教务处", "本科教务"], adapter: "zdbk", base: "https://zdbk.zju.edu.cn", columns: [
    { id: "本科生院通知公告", name: "本科生院通知公告", aliases: ["本科生院"], audience: "undergrad", default: true, feed: true },
    { id: "各院系通知公告", name: "各院系通知公告", aliases: ["院系", "院系通知", "学院通知"], audience: "undergrad", default: true, feed: true },
  ] },
  // 选课、考试等教学运行通知教务网几乎全有；这两栏的推免与主修确认公示、毕业生信息核对、竞赛、大创、境外交流等大多只在官网。
  { id: "bksy", name: "本科生院", aliases: ["本科生院官网"], adapter: "webplus", base: "https://bksy.zju.edu.cn", columns: [
    { id: "76425", name: "学籍管理", audience: "undergrad", default: true, feed: true, unordered: true },
    { id: "76426", name: "实践交流", audience: "undergrad", default: true, feed: true, unordered: true },
  ] },
  // 学工部管本科生，研究生的对应部门是研工部。
  { id: "xgb", name: "学工部", aliases: ["学工", "学生工作部", "学工门户"], adapter: "webplus", base: "http://www.xgb.zju.edu.cn", columns: [
    { id: "53388", name: "最新通知", audience: "undergrad", default: true, feed: true },
    { id: "53403", name: "重要通知", audience: "undergrad", default: true, feed: true },
    { id: "53395", name: "评奖评优", aliases: ["奖学金"], audience: "undergrad", default: true, feed: true },
    { id: "53396", name: "学生资助", aliases: ["资助"], audience: "undergrad", default: true, feed: true },
    { id: "53405", name: "公示公告", audience: "undergrad", default: true, feed: true },
  ] },
  { id: "ygb", name: "研工部", aliases: ["研究生工作部"], adapter: "webplus", base: "http://ygb.zju.edu.cn", columns: [
    { id: "31555", name: "通知公告", audience: "grad", default: true, feed: true },
    { id: "31546", name: "奖助事务", audience: "grad", default: true, feed: true },
  ] },
  // 「全部公告」两年十几条；研究生教务系统（yjsy，前端渲染）未接。
  { id: "grs", name: "研究生院", aliases: ["研院"], adapter: "webplus", base: "http://www.grs.zju.edu.cn", columns: [
    { id: "qbgg", name: "全部公告", audience: "grad", default: true, feed: true },
  ] },
  // 二课、志愿服务、社会实践、社团、创新创业的通知。「通知公告」是下面各分类的汇总，默认只读它；分类栏供指名。
  // 团委以前的域名会跳到这个地址。
  { id: "youth", name: "团委", aliases: ["校团委", "共青团", "二课", "第二课堂"], adapter: "webplus", base: "https://zjutw.zju.edu.cn", columns: [
    { id: "tzgg", name: "通知公告", default: true, feed: true },
    { id: "shsjhzyz_32442", name: "实践志愿", aliases: ["志愿", "志愿服务", "社会实践"] },
    { id: "st_49186", name: "素质拓展" },
    { id: "xskj_32440", name: "创新创业", aliases: ["双创"] },
    { id: "wt_32438", name: "校园文化" },
    { id: "st_32443", name: "学生社团", aliases: ["社团"] },
    { id: "xsh_44064", name: "学生会" },
    { id: "qmgc", name: "青马工程" },
  ] },
  // 「即时更新」是全校各部处通知按时间的流，工作日十条上下，多为教职工事务（基金指南、招聘、经费认领），不进默认集；
  // 「教育教学」「重点提示」是它的子集：前者以学生事务为主，后者只有几条，是停电、封路、班车、升旗这类校园生活提示。
  // 其余栏目（科学研究、校务管理、会议通知、招聘信息等）同为子集，不单接。
  { id: "zhfw", name: "综合服务网", aliases: ["综合服务", "全校通知", "学校通知"], adapter: "webplus", base: "http://zhfw.zju.edu.cn", columns: [
    { id: "zhfw_jyjx", name: "教育教学", default: true },
    { id: "zhfw_zdts", name: "重点提示", default: true },
    { id: "zhfw_jsgx", name: "即时更新", aliases: ["全部通知"], feed: true },
  ] },
  // 需要统一身份认证，列表日期只到月份。
  { id: "itc", name: "信息技术中心", aliases: ["信息中心", "网络中心"], adapter: "webplus", base: "https://itc.zju.edu.cn", columns: [
    { id: "90618", name: "通知公告" },
  ] },
  { id: "libweb", name: "图书馆", adapter: "webplus", base: "http://libweb.zju.edu.cn", columns: [
    { id: "55989", name: "本馆新闻" },
    { id: "55543", name: "资源动态" },
  ] },
];
