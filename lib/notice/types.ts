/** 通知模块的公共类型：来源表、列表条目、正文。 */

/** 来源里的一个栏目 */
export interface Column {
  /** 网站群栏目号或栏目路径（76425、zhfw_jyjx）；教务网为通知类别名 */
  id: string;
  /** 栏目不在来源的主站下时的站点地址（学院的办公网、子站） */
  base?: string;
  name: string;
  aliases?: string[];
  /** 只面向本科生或研究生；不写表示都适用。默认集和增量集按使用者的类别取 */
  audience?: "undergrad" | "grad";
  /** 不指名来源时也读 */
  default?: boolean;
  /** notice new 的增量扫描读这一栏 */
  feed?: boolean;
  /** 列表顺序不代表时间（几乎每条都置顶），要读完全部页再排序 */
  unordered?: boolean;
}

/** 一个通知来源：站点当数据，抓取方式由 adapter 决定 */
export interface Source {
  id: string;
  name: string;
  aliases?: string[];
  adapter: "zdbk" | "webplus";
  base: string;
  columns: Column[];
}

/** 列表里的一条通知 */
export interface Notice {
  /** 去重与已读记录用：教务网通知编号、网站群文章号（wp-<id>），其余为链接 */
  id: string;
  /** 教务网列表里的标题可能被截断（以 … 结尾） */
  title: string;
  titleTruncated: boolean;
  publisher: string;
  date: string;
  /** 来源·栏目，如「学工部·评奖评优」 */
  source: string;
  sourceId: string;
  pinned: boolean;
  /** 外链通知或原始附件，查询正文时跟随该地址。 */
  externalUrl?: string;
  url: string;
}

export interface NoticeDetail {
  id: string;
  title: string;
  publisher: string;
  publishedAt: string;
  /** 页面上标注的来源单位（综合服务网的「来源:基本建设处」） */
  origin?: string;
  /** 正文位于其他页面或站点；是否完整以 contentStatus 为准。 */
  external?: boolean;
  externalUrl?: string;
  /** 正文纯文本 */
  text: string;
  /** 正文里的链接与图片/附件（file_download 是附件） */
  links: { url: string; text: string; attachment: boolean }[];
  url: string;
  contentStatus: "full" | "summary-only" | "attachment-only" | "unavailable";
  attachments: { url: string; text: string }[];
}

export interface ListQuery {
  /** 标题关键词，命中任一个即可；空数组表示不按关键词筛 */
  terms: string[];
  since?: string;
  until?: string;
  limit: number;
}

export interface ListResult {
  /** 符合条件的条目，按日期由新到旧 */
  notices: Notice[];
  hasMore: boolean;
  /** 没有读到所需范围的尽头就停了：只检索到这个日期 */
  scannedTo?: string;
}
