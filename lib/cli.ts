/** Public module registry. Importing it does not run the CLI or authenticate. */
import { retired, type Command } from "./core/command.ts";
import { profileCommands } from "./profile/cli.ts";
import { webvpnCommands } from "./webvpn/cli.ts";
import { zjuamCommands } from "./zjuam/cli.ts";
import { cc98Commands } from "./cc98/cli.ts";
import { chalaoshiCommands } from "./chalaoshi/cli.ts";
import { zdbkCommands } from "./zdbk/cli.ts";
import { noticeCommands } from "./notice/cli.ts";
import { sztzCommands } from "./sztz/cli.ts";
import { ebookCommands } from "./ebook/cli.ts";
import { labCommands } from "./lab/cli.ts";
import { xuezaiCommands } from "./xuezai/cli.ts";
import { zhiyunCommands } from "./zhiyun/cli.ts";
import { tyysCommands } from "./tyys/cli.ts";
import { ptaCommands } from "./pta/cli.ts";
import { chaoxingCommands } from "./chaoxing/cli.ts";
import { cnkiCommands } from "./cnki/cli.ts";
import { docCommands } from "./doc/cli.ts";
export const modules: Record<string, {
    description: string;
    commands: Record<string, Command>;
    hidden?: boolean;
}> = {
    profile: { description: "配置初始化与脱敏查看", commands: profileCommands },
    webvpn: { description: "网络诊断、WebVPN 会话与 URL 工具", commands: webvpnCommands },
    zjuam: { description: "统一身份认证维护", commands: zjuamCommands },
    zdbk: { description: "课表、考试安排、成绩绩点、培养方案与自主选课", commands: zdbkCommands },
    notice: { description: "学校各单位和本人学院的通知公告：教务网、学工部、研工部、团委、综合服务网、各学院官网等，检索、全文与新通知", commands: noticeCommands },
    sztz: { description: "二三四课堂（素质拓展平台）：活动中心、可申请记点的项目、本人记点与成绩单，活动报名、取消报名与收藏", commands: sztzCommands },
    ebook: { description: "学校订购的电子图书：有没有某本书的电子版、在哪个平台有全文（图书馆电子书刊导航和超星）", commands: ebookCommands },
    lab: { description: "实验课表、报告成绩、班次余量与选课执行", commands: labCommands },
    xuezai: { description: "课程资料、作业、待办与点名", commands: xuezaiCommands },
    tyys: { description: "体艺考勤查询与体育场馆预约", commands: tyysCommands },
    pta: { description: "PTA 独立登录、作业进度、小题保存与提交", commands: ptaCommands },
    chaoxing: { description: "超星学习通的课程、课件与视频下载", commands: chaoxingCommands },
    zhiyun: { description: "课堂资源查询、下载、实时字幕与本地转写", commands: zhiyunCommands },
    cc98: { description: "论坛查询、个人中心与互动发布", commands: cc98Commands },
    chalaoshi: { description: "教师评价与课程绩点", commands: chalaoshiCommands },
    cnki: { description: "中国知网文献检索、筛选与全文 PDF 下载", commands: cnkiCommands },
    doc: { description: "PDF、Word、PPT、Excel 等文件或链接转文字；图片与 Word 转 PDF、合并、取页、找页、取图、渲染", commands: docCommands },
    net: { description: "旧网络入口，请使用 webvpn", hidden: true, commands: {
            check: retired("webvpn check --host HOSTS"),
            "clear-cache": webvpnCommands["clear-cache"]!,
        } },
};
export function resolveCommand(parts: string[]): {
    system: string;
    path: string[];
    command?: Command;
    rest: string[];
} {
    const [system = "", action, ...tail] = parts;
    let command = action ? modules[system]?.commands[action] : undefined;
    const path = action ? [action] : [], rest = [...tail];
    while (command?.children && rest[0] && command.children[rest[0]]) {
        const next = rest.shift()!;
        path.push(next);
        command = command.children[next];
    }
    return { system, path, ...(command ? { command } : {}), rest };
}
