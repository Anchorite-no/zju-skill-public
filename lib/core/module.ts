/**
 * 模块能力声明。每个系统模块导出一份 `requirements`，说明它需要什么：
 *   - auth：需要哪种登录态（cas = 统一身份认证委托；none = 无需登录；own = 自有账号体系如 CC98）
 *   - network：campus = 校内站点，默认统一经 WebVPN 访问；public = 公网可达
 *   - writes：是否包含写操作
 *
 * 两个维度相互独立，由网站自身决定：要校园身份 → auth=cas；只在校网 → network=campus。
 * 组装层据此注入 CAS 组件和 WebVPN 传输；会话先复用，缺失或失效时认证，不逐次预检。
 * 新增模块只要填这份声明，就能复用 zjuam/webvpn/transport，不用自己拼登录链。
 */
export type AuthKind = "cas" | "none" | "own";
export type NetworkKind = "campus" | "public";

export interface ModuleRequirements {
  /** 模块短名，与目录名一致 */
  name: string;
  /** 中文全名 */
  title: string;
  /** 真实主机名列表；transport 只对这些主机做重写/代理 */
  hosts: string[];
  auth: AuthKind;
  network: NetworkKind;
  writes: boolean;
  /** auth=cas 时：CAS 委托用的 service URL */
  casService?: string;
  /** 可选会话检查端点；具体有效性由模块判断 */
  sessionProbe?: string;
  /**
   * network=campus 的模块里，个别从校外实测公网可达的主机（带端口时写 host:port）：这些直连，不经 WebVPN。
   * 用在一个模块要访问很多网站、其中只有一部分只在校园网的时候（通知模块的逐站标注表）。
   */
  publicHosts?: string[];
}
