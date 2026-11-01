# 教务网 请求与协议

CLI 用法见 [教务](../../references/zdbk.md)、[选课](../../references/zdbk-selection.md)。本文件记录登录链、端点、表单与解析细节，供开发和排障使用。

教务网通知公告的端点与解析在 [通知 README](../notice/README.md)；notice 模块借用本模块的 `Zdbk` 会话，本模块不依赖它。

- 声明：`auth=cas network=public writes=true`（公网可达，直连；自主选课写闸）。
- 代码：`lib/zdbk/{client,kbcx,kscx,cjcx,pyfagl,xsxk,selection-cli,index}.ts` · CLI：`zju zdbk …` · 会话：`data/sessions/zdbk.json`（TTL 2h）

## 登录链与会话

`zjuam.loginService("https://zdbk.zju.edu.cn/jwglxt/xtgl/login_ssologin.html")` → 302 回跳 `index_initMenu.html;jsessionid=…` 拿会话。
本地 jar 里有三个 path 下的 cookie（CookieJar 按 path 区分，缺一不可）：`JSESSIONID@/jwglxt`、`JSESSIONTOKEN@/`、`JSESSIONPREJSDM@/jwglxt/xtgl`（另 `route@/`）。
会话检查：GET `xtgl/index_initMenu.html?jsdm=06` → 200 且无 `id="loginForm"` 即有效。
失效表现（2026-09-17 实测）：**接口 HTTP 901 空体**；页面 302 到 `login_slogin|login_ssologin|/cas/login`（无 ticket）；页面 body 含 `id="loginForm"`。客户端存活的会话服务端约 30 分钟不动就踢，所以请求层失效自动重登一次再重放。

连接或 TLS 握手阶段断开（请求尚未发出）时，`Zdbk.request` 对所有请求重发一次；其他传输错误不重发。

## 通用规矩

- 功能模块 URL 必须带 `?gnmkdm=<模块码>&su=<学号>`；**通知是例外**（`gnmkdm=index`，带不带 su 都行，实测缺 su 也不 404）。
- 模块码：通知 `index`、培养方案 `N153020`、课表 `N253508`、考试 `N509070`、成绩 `N5083`、成绩主修数据 `N908550`、选课 `N253530`。学生端全部功能码可 POST `xtgl/index_cxLeafGnmkdm.html` 取得（`gnmkdm/gnljmc/dyym`）。
- 列表都是 jqGrid：POST `<url>.html?doType=query`，表单 `queryModel.showCount` / `queryModel.currentPage` / `queryModel.sortName` / `queryModel.sortOrder`（+ `time:1`），响应 `{items, totalResult, totalPage}`。每行都带一堆噪音字段（queryModel/userModel/…），`stripRow` 统一剥掉。
- 行内富文本用 `<br>` 分隔；表格模式课表用 `zwf` 当换行分隔符（前端 replace 成 `<br>`）。

## 端点（全部 2026-09-17/18 实测）

| 短名 | 方法 | 路径 | 说明 |
|---|---|---|---|
| kb-terms | POST | `kbcx/xskbcx_cxXueqiList.html` | 表单 `xxqf=0`（表格模式）→ `1|秋…1|暑, 2|春…2|短`；`xxqf=1`（列表模式）→ `1|秋、冬`、`2|春、夏` |
| kb-open | POST | `kbcx/xskbcx_cxSfkc.html?xn=…&xqm=…` | 返回字符串 `"OK"` 或提示语（该学期课表未开放等） |
| kb | POST | `kbcx/xskbcx_cxXsKb.html?gnmkdm=N253508&su=` | 表单 `xnm`（2026-2027）、`xqm`（1\|秋）、`xxqf`、`xsfs`。响应 `{xh,xm,xzb,xy,zy,xkkg,kbList,kbcdList,sjkList,xskList,ywkList,jxkList,fKbList}`。**列表模式（xxqf=xsfs=1）**：kbList 每项 kcmc/kcdm/jsxm/xxq/sksj/skdd/xksj 选课时间/xkzy 志愿/szjcmc 数字教材，组合学期可用。**表格模式（=0）**：每项 xqj 星期/djj 第几节/skcd 节长/dsz 单双周(0单1双2全)/kcb 汇总串（含考试时间，`zwf` 分隔）。非正式课在 sjk 实践/xsk 线上/ywk 英文/jxk 进修/fKb 服从调配（tpjg 调配结果） |
| pyfa | POST | `pyfagl/pyfaxxcx_cxPyfaxscxIndex.html?doType=query&gnmkdm=N153020&su=` | 表单 `synj` 入学年、`xydm` 学院、`zydm` 专业、`dlbs` 类别、`jxjhh` 计划号模糊。行：`jxjhh`（=pyfaxx_id，PDF 的 id）、zymc/xymc/zdbyxf 最低毕业学分/syxw/xz 学制/`zyhxkc` 核心课（**双空格分隔**，不是 `<br>`）/qywkc 前沿课/pymb/pyyq |
| pyfa-majors | POST | `xtgl/comm_cxPyfaZyxxList.html?rangeType=ggxydm&rangeable=false` | 表单 `njdm_id`、`jg_id`，返回 `[{zydm, zyh_id, zymc}]` |
| pyfa-pdf | GET | `pyfagl/pyfayl_cxPyfaylPdf.html?id=<jxjhh>&doType=query` | PDF 二进制（iText，UniGB-UCS2-H CMap），实测 334–349 KB，`inline;filename=""` |
| my-plan（推导） | GET | `xsxk/zzxkghb_cxZzxkGhbIndex.html?gnmkdm=N253530&su=` | 选课首页隐藏域 `nj` + `zydm` → 教学计划号 `nj+zydm`（本人 20252112）。与 course_choser 的选课上下文同源 |

## CLI 封装时的结论（2026-10-03 实测）

- HTTP 922：同一账号在另一台机器登录后，被顶掉的会话下一次请求可能返回 922（也可能是 901 或登录页），都按会话失效处理：重新登录后再发一次读请求；写请求不重放，返回会话失效由业务层回查。两台机器在几分钟内反复交替登录时，CAS 回跳偶尔仍落在登录页（连续三次都可能失败，过一会儿自行恢复）；登录内部隔 1.5 秒再走一次，仍不行则报认证失效，不继续重试以免加重。

- 培养方案列表一个年级约 150 个，`queryModel.showCount=500` 一次取全（540 ms）。CLI 按学院名、专业名在本地筛选，不再让调用方传学院、专业代码。
- 选课课程行（搜索、类别列表）没有 `xf`，学分在 `kcxx`（`0~3.0~3.0-0.0` 的第二段）。教学班行没有课程名，`jsxm`、`sksj`、`skdd` 多值用 `<br>` 分隔，空值是 `--`。
- 选课页签有三个都叫「全部课程」（`xk_b`、`xk_n`，以及页面上显示为 `qbkc` 的 `xk_rdxkc`），CLI 用它下面第一个子类区分。

## 学期码

`xnm="2026-2027"`（学年），`xqm`：表格模式 `1|秋` `1|冬` `1|短` `1|暑` `2|春` `2|夏` `2|短`（数字=上下学期）；列表模式可用组合 `1|秋、冬`、`2|春、夏`。URL 里 `|` 要 encodeURIComponent。

## 其他坑

- HTTP 901 不是标准状态，是正方的"会话失效"自定义码，别当 5xx 重试。
- 培养方案列表 `gjzydm`（国际专业代码）参数留空即可；`zydm` 与页面下拉里的 `zyh_id` 同值。

## 考试

首页功能搜索“考试”核实 `gnmkdm=N509070`。GET `xskscx/kscx_cxXsgrksIndex.html` 读取 xnSelect/xxqSelect 默认学年学期；POST 同一路径 `?doType=query`，表单 `xxq=秋`、`xnxq=(2026-2027-1)-` 和内部 queryModel 分页。页面首次查询不传条件会混入往年记录，CLI 始终传入明确学期并自动取全页。

## 成绩

- 成绩：POST `cxdy/xscjcx_cxXscjIndex.html?doType=query&gnmkdm=N5083&su=`，表单 `xn`、`xq`（1=秋冬，2=春夏）、`zscjl`/`zscjr` 成绩段，全空即全部学期。行：`xkkh`（`(2025-2026-1)-课程代码-…`，学年学期从这里解析）、`kcmc`、`cj`（分数或弃修/缓考/合格等文字）、`xf`、`jd`（教务网给出的五分制绩点）、`bkcj` 备注。本人实测 24 行。
- 成绩主修数据：POST `zycjtj/xszgkc_cxXsZgkcIndex.html?doType=query&gnmkdm=N908550&su=`，表单 `xh`、`kcmc` 留空。返回主修课程池（本人 290 行），`xdbj=1`/`xdbjmc=已修` 的行才带 `xkkh/cj/zscj 折算成绩/jd/xn/xqmc`。

## 自主选课接口

实现：`lib/zdbk/xsxk.ts`，入口导出 `Xsxk`；CLI：`lib/zdbk/selection-cli.ts`。复用项目 CAS 登录与 `Zdbk` 会话，适用于常规选课的查询、选择教学班志愿、排序、直接退选和回查。

### TypeScript 组合

```ts
import { openZdbk, Xsxk } from "../lib/zdbk/index.ts";

const z = await openZdbk();
try {
  const xk = new Xsxk(z);
  const found = await xk.search({ keyword: "微积分基础", size: 10 });
  const course = found.items[0];
  if (!course) throw new Error("未找到课程");
  const classes = await xk.sections(course.query);
  const section = classes[0];
  if (!section) throw new Error("未找到教学班");
  const preview = await xk.select(section.choice, { dryRun: true });
  // 向用户展示实际课程、教学班和预览，再按其授权进行写操作。
} finally {
  z.close();
}
```

写 API 接受 `{ confirm: true, journal(event) }`，同样检查环境变量写闸。调用方负责提供持久化 journal；CLI 已自动处理。API 不关闭传入客户端，由调用方关闭；同账号操作应串行，避免在排序期间同时改变该组志愿。

### 实测发现

- 教学班响应不带 `kcdm`，解析时沿用这次查询的课程代码。
- 课程池不止 `T(...)`、`A(...)`，体育课使用 `4(...)`；提交仍使用无池前缀的实际教学班号。
- 班级表名实测含 `xkrw2006view`、`cfbjxrwb`、`tykjxrwb`，必须取实际返回值。
- 页签 `data-dl` 有与点击参数不一致的情况，按 `categroyClick` 实参识别。认定型课程的多个类别共用 `xk_rdxkc`，以类别名进一步区分。
- 原始响应的 `queryModel/userModel` 等无关字段不输出；保留课程、教学班、志愿及状态字段。

尚未接入跨专业选择面板、补考选课特殊流程、研究生课程跳转、课程全集枚举和补退选申请。选课规则见 [选课](../../references/zdbk-selection.md)。

### 业务语义来源与原脚本

常规选课复用教务平台的查询、志愿提交与回查接口；补选申请尚未接入。

当前前端还有体育课分组，以及 `xkzyfz`、`zyfzByKcdm` 等字段；不能只按课程代码去重或判断志愿上限。[S5] CC98 常见“三志愿”说法只辅助理解，本次选课首页实际 `xkzys=1`，不能永久写死为 3；这个值也不能单独证明选课开放。

当前首页 `xf9` 表示本学期总学分，`xf91` 表示秋冬等长学期学分，`xf92` 表示短学期学分。是否完整包含补选申请，以及特殊课程的低定计分口径，仍需核实接口。[S5] CC98 有军训、国家安全教育不计入的说法，本次没有正式计分明细，不编码成固定例外。[C3]

本次未打开具体班级的申请表，也未提交申请。理由与电话仅确认了前端必填校验，完整表单字段语义需后续只读探查。

当前前端拦截删除已确认的普通补选申请；具体撤销时间、拒绝状态和服务端约束未实测。[S6]

### 前端接口证据

#### 已读取的入口

- 自主选课首页 `GET xsxk/zzxkghb_cxZzxkGhbIndex.html`，`gnmkdm=N253530`。
- 菜单查询 `POST xtgl/index_cxFilterGnmkdm.html`，表单 `gnmkmc=补退选`，返回 `N253540` 与 `/xsbtx/xsbtx_cxXsbtxIndex.html`。
- 补退选首页 `GET xsbtx/xsbtx_cxXsbtxIndex.html`，`gnmkdm=N253540`。
- 当前 `zzxkghb.js`、`xsbtx.js` 静态脚本。下述写接口只读源码，均未调用。

#### 自主选课字段与写路径

| 字段 | 当前前端用途 | 注意事项 |
|---|---|---|
| `sfxz` | 班级行中 `1` 显示退选按钮，补考另有 `2` 分支 | 与筛选结果不同 |
| `sxbj` | `1` 蓝色“已选上”，其他值红色“待筛选” | 保留原值，结合阶段解释 |
| `xkzys` / `xkzy` | 最大志愿数／记录的志愿次序 | 志愿数取实时配置 |
| `xkzyfz` / `zyfzByKcdm` | 志愿分组／按课程分组标记 | 通识、体育不能仅按课程代码分组 |
| `xf9` / `xf91` / `xf92` | 总学分／长学期／短学期 | 不直接视为完整低定计分 |
| `rs` / `yxrs` | 余量容量／专业与全部待定人数 | `ylxs=2` 时前端隐藏待定人数列 |

前端新添志愿时有“这里无论怎样都是待筛选”的显示逻辑。原始 `sxbj` 与业务结果分开保留：常规志愿需要等筛选，低定提交成功并入账即按已获得处理，不等待显示变蓝。[S5、L1]

选课源码：`POST xsxk/zzxkghb_xkBcZyZzxkGhb.html`，参数 `xn,xq,nj,xkkh,tabname,xkzys`。退课源码先查 `zzxkghb_cxChoosedKcxx.html`，再提交 `zzxkghb_tuikBcZzxkGhb.html`，参数 `xkkh`。退课地址已确认来自前端，尚未真实提交验证。

志愿排序源码：`POST xsxk/zzxkghb_xkBcZypxZzxkGhb.html`，`xkkhs` 为逗号分隔的教学班号，`zypxs` 为一一对应的志愿序号。当前前端将每个变更组的完整志愿按新次序提交，各组从 1 编号，成功响应检查字符串 `success`。应保持服务端志愿分组，不跨组排序；本次只读源码，未提交排序。

#### 补退选端点（仅前端证据，业务响应尚未实测）

前缀 `xsbtx/`，模块 `N253540`；功能 URL 还需 `su`。

| 路径 | 用途与前端参数 |
|---|---|
| `xsbtx_cxKcxxList.html` | 课程搜索 `cxlb,cxnr`；前端取 `KCDM,KCMC` |
| `xsbtx_cxPreApplyList.html` | 待申请班级 `doType=query,kcdm,sqlx`，可附 `cxlb,sksj,lb`；列中含容量 `rl`、已选 `yxrs`、申请数 `bxrs` |
| `xsbtx_cxYsqkcList.html` | 已申请列表，审核码 `sqqr`、审核文本 `sqqrmc`、类别 `lb` |
| `xsbtx_cxCheckNormalBxApply.html` | 普通补选检查 `xkkh`；`flag=1/2` 时打开表单 |
| `xsbtx_cxXsbtxTable.html` | 表单 `xkkh,czlb`；字段语义待读取真实表单 |
| `xsbtx_zjXsbxApply.html` | **写**：普通补选，`xkkh,xn,xq,xxq,id,sqly,sfct,sfmt,jcyd,lxdh`；前端成功分支检查字符串 `success` |
| `xsbtx_zjXsbtxApply.html` | **写**：其他类别／退选申请 `sqlx,xkkh,kcdm`；成功分支检查 `flag=1` |
| `xsbtx_scBxApply.html` | **写**：删普通补选申请 `xkkh`；前端拦截 `lb=0 && sqqr=1` |
| `xsbtx_scXsbtxApply.html` | **写**：删其他补退选申请 `xkkh,sqlx` |

前端识别 `lb=0` 普通补选、`1` 冲突、`2` 容量已满、`T` 退选申请，但也含旧分类页签注释。应读取当期实际开放的页签，不能假设历史分支仍适用。新申请前端暂设 `sqqr=0`；完整审核枚举以真实列表和 `sqqrmc` 核验，不从数字猜测。

### 待实现与待核实

1. 从已有脚本接入通用查询：上下文、已选、学分、课程、班级和搜索，保留状态、志愿序号与分组原值。
2. 复用选课提交并补齐志愿排序，先完成常规的“查询 → 选择志愿 → 提交／调整 → 回查”。前三轮共用该流程，无需抢课循环或本地彩票算法。
4. 补选作为独立模块接入查询、表单、申请、审核和撤销。其计分未核清时影响低定资格判断，不阻塞通用查询及常规志愿管理的开发。

流程层结合通知与服务端信息明确运行模式；不能仅由 `sxbj` 或页面可打开推断。各写操作仍遵循写闸，超时后先查记录，避免未知结果直接重发。

现有 `Zdbk.request` 在会话失效后会重登录并重放一次请求，接写接口前要审查其适用范围。保留 `course_choser` 对低定成功和待筛选已获得的处理，常规模式将同一提交结果解释为志愿保存成功；学分汇总按实际口径单独校验。

待核实：补选申请各状态如何计分，特殊课程和短学期计分，志愿组去重，是否可同时申请同课多个班，审核状态完整枚举，以及窗口关闭后的业务响应。不得用论坛经验或接口命名代替验证。

### 调研来源

官方优先。C1 旧指南的“预置课拖第三志愿保底”弃用，S1/S3 明确调整志愿会重新筛选。C2 的“低定不抢了”说法按 S2 纠正为仅退课余量晚间随机释放。C3 特殊课程计分仅作待验证线索。

原始响应、按需读取的论坛内容、页面、脚本和手册保存在本地忽略目录 `data/output/zdbk-selection-research/`，不纳入版本库。

- L1：用户于 2026-09-19 补充常规／低定的业务语义；本地 `course_choser/src/zju.js`、`src/courses.js`、`src/runner.js`、`tools/search.mjs` 已只读核对。`reconcile` 明确将包括待筛选在内的已有记录计为 `owned`。
- S1：[2026-2027 秋冬本科课程选课安排](https://zdbk.zju.edu.cn/jwglxt/xtgl/xwgl_ckXw.html?xwbh=52D7480DCC55A050E0632AB3CA0ACC17&doType=save)，本科生院，2026-05-28。
- S2：[2026-2027 秋冬本科课程第三轮选课通知](https://zdbk.zju.edu.cn/jwglxt/xtgl/xwgl_ckXw.html?xwbh=5ADD2E8131280957E06329B3CA0AAA5B&doType=save)，本科生院，2026-09-07。
- S3：[2026 级本科新生第一学年秋冬选课通知](https://zdbk.zju.edu.cn/jwglxt/xtgl/xwgl_ckXw.html?xwbh=569D011381027E3FE06329B3CA0A448F&doType=save)，本科生院，2026-07-15。
- S4：[S3 附件《选课操作手册》](https://zdbk.zju.edu.cn/jwglxt/zjdxFilemgr/file_download.html?uid=569CF3B93BFFD98CE0632AB3CA0A55C6)，9 页，已提取全文并查看状态、志愿、检索相关的第 5–8 页图像。截图含历史学期示例，日期不当作现行政策。
- S5：[当前自主选课前端 zzxkghb.js](https://zdbk.zju.edu.cn/jwglxt/js/comp/jwglxt/xkgl/xsxk/zzxkghb.js?ver=29828226) 及本人登录后的选课首页，2026-09-19 读取。
- S6：[当前补退选前端 xsbtx.js](https://zdbk.zju.edu.cn/jwglxt/js/comp/jwglxt/xkgl/xsbtx/xsbtx.js?ver=29828226)、菜单及补退选首页，2026-09-19 读取。
- C1：[【新生】选课操作指南～从零开始的“买彩票”生活【兼答疑楼】](https://www.cc98.org/topic/4962967)，2020-09-10 发布，正文含后续更新；用于理解操作并识别过时建议。
- C2：[补选低定政策有变化，真的假的](https://www.cc98.org/topic/6622086)，2026-09-14，重点核对第 1、5、6 楼，最终采用 S2。
- C3：[现在不是低定吗，为什么我超过了22也可以选课？](https://www.cc98.org/topic/6625849)，2026-09-16，第 3 楼涉及特殊课程计分，未作为官方规则。
- C4：[面向大一小朋友的简易选课指南](https://www.cc98.org/topic/6600641)，2026-08-22，作为 C1 和其他经验帖的检索线索；未把其 PDF 当作官方手册。
- C5：[选课的“奇技淫巧”（准大四学生的选课“焚决”）](https://www.cc98.org/topic/6528240)，2026-06-05，作者自述经验，用作多轮调整背景，不作为筛选算法或概率的官方依据。
