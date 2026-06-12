/**
 * 小黑盒资讯流相关类型.
 *
 * 同 zhihu 模块的处理思路一致: 服务端字段繁多且不稳定 (官方私有 APP API), 这里只
 * 声明真正用到的子集, 其它字段直接保留 unknown / 不写, 不影响解码也不锁定结构.
 *
 * 对资讯列表来说我们关心的核心字段 (按实测 /bbs/app/feeds/news 抓包):
 *   - content_type:   1=普通帖子 (我们要的); 10=头部专题工具栏 (要过滤)
 *   - linkid:         资讯唯一 id (数字), 跨页 / 跨刷新去重就靠它
 *   - title:          标题
 *   - description:    摘要
 *   - imgs / thumbs:  封面图 (imgs 原图, thumbs 缩略)
 *   - post_tag:       作者昵称 (字段名很迷, 但实测就是作者)
 *   - has_video:      0/1, 1 表示视频帖
 *   - formated_time:  服务端已格式化好的 "3 小时前" / "yyyy-MM-dd" 字符串, 直接用
 *   - hashtags[]:     话题标签数组, 取第 0 个作为卡片标签
 *   - share_url:      服务端给的完整分享 URL (注意里面的 link_id 是 hash 不是 linkid)
 *   - 统计:           comment_num / link_award_num
 */

/**
 * 板块 (Section) id —— 插件层的"友好 id".
 *
 * 取值规则:
 *   - 'home': 主页推荐流 (本地多源混排, 不是真实服务端接口); 不可被禁用, 永远是第一个 tab
 *   - 其它:   各游戏板块, 字符串走 vscode 配置 / globalState key, 跟 SectionMeta.id 一致
 *
 * 注意:
 *   - 这里用 string 而不是 union literal — 内置板块的 id 在 BUILTIN_SECTIONS 里维护
 *     (运行时还可能新增, 比如字典发现的板块), 用 string 包容更省心
 *   - 旧版本叫 XiaoheiheGameId, 保留 alias 兼容 (现有 client/types 还在引用)
 */
export type XiaoheiheSectionId = string;
/** @deprecated 用 XiaoheiheSectionId 替代; 保留是因为 client 还在用 */
export type XiaoheiheGameId = XiaoheiheSectionId;

/**
 * 板块 meta —— UI 展示 + 服务端 tag 映射.
 *
 * verified 标志:
 *   - true:  原参考实现 (vscode-maxPlus) 抓包验证过 tag 有效
 *   - false: 基于小黑盒社区高频出现猜的 tag, 没我亲手验证过. 用户勾选后若服务端返回
 *            空数据 (tag 错), 前端会提示"可能 tag 已变更, 可点 ⚙ 取消勾选"
 */
export interface XiaoheiheSectionMeta {
  /** 板块 id, 全小写无破折号; 'home' 保留给主页推荐流 */
  id: XiaoheiheSectionId;
  /** 给前端 UI 用的中文短名 (tab 文案) */
  label: string;
  /**
   * 打到服务端 APP 协议 /bbs/app/feeds/news 的 tag 字段值 (字符串, 如 'overwatchtwo').
   * 主页 (id='home') 这里填空字符串, fetch 时走 fetchHomeFeed 不走 tag.
   * 在没有 topicId 或登录态获取推荐失败时, 这条 tag 路径是最终兜底.
   */
  tag: string;
  /**
   * 打到服务端 web 协议 /bbs/app/topic/feeds 的 topic_id 字段值 (数字字符串, 如 '23563').
   *
   * 这是 v2.2.6 新增的"分板块推荐流" 入口 — 真实抓包确认 https://www.xiaoheihe.cn
   * 单板块页走的是 /bbs/app/topic/feeds?topic_id=<数字> 接口, 服务端按 pkey 个性化
   * 推荐排序 (跟 /bbs/app/feeds 主页推荐同源, 只是多一个 topic_id 过滤维度).
   *
   * 取值: 必须是数字字符串, 跟小黑盒"话题/板块"内部数字 id 一致. 获取方式:
   *   抓 https://www.xiaoheihe.cn/app/bbs/<slug> 首屏 XHR 请求, query 里 topic_id.
   *
   * 仅"已登录态"下生效 — 未登录时 web 协议无 pkey, 接口会返回非法请求.
   * 缺失 (undefined) 时该板块完全走老 APP tag 路径 (匿名, 无推荐, 按时间序).
   *
   * 内置已知 topicId 一览 (待补全):
   *   - ow:   '563627' (守望先锋, 用户 2026/06 抓单板块 feeds 响应里 link.topics[0].topic_id 确认;
   *                     早期 v2.2.6 草稿误写过 '23563' 实为别的页面 query 错认, 已修正)
   *   - sjz / csgo / apex / lol / pubg: TODO 待抓包 (也可走运行时自动累积, 见 globalState
   *     'xiaoheihe.topicMap' 字典 — feeds 响应 link.topics[] 旁路累积, 零额外请求)
   */
  topicId?: string;
  /**
   * 是否抓包验证过 tag 有效 — 仅作为内部元数据 (维护参考),
   * UI 不再露出此字段 (历史曾在 tab/设置面板加 "?" / "未验证" 角标, 已移除).
   */
  verified: boolean;
}
/** @deprecated 旧名, 用 XiaoheiheSectionMeta */
export type XiaoheiheGameMeta = XiaoheiheSectionMeta;

/**
 * Home 主页板块的常量 id —— 多处用到, 抽常量防拼错.
 *
 * 主页流的实现策略 (见 XiaoheiheClient.fetchHomeFeed):
 *   把用户当前启用的所有"非 home"板块 round-robin 拉前几条, 本地混排成"个性化推荐流".
 *   不依赖任何未知接口, 100% 可用. 用户启用的板块越多, "推荐"越丰富.
 */
export const HOME_SECTION_ID: XiaoheiheSectionId = 'home';

/** 主页板块 meta (固定, 不可禁用) */
export const HOME_SECTION_META: XiaoheiheSectionMeta = {
  id: HOME_SECTION_ID,
  label: '主页',
  tag: '',
  verified: true, // 不依赖任何 tag, 不存在 verified 问题
};

/**
 * 内置板块清单 (不含 home; home 单独处理).
 *
 * 加新板块只需要 push 一项 — UI / 配置 / Client 都自动适配.
 *
 * tag 约定:
 *   - 大小写敏感, 跟服务端约定一致 (实测 csgo / APEX / lol / PUBG 大小写不统一)
 *   - 三角洲的 tag 是 'topic_611472' — 这是小黑盒 APP 内部话题 id, 没独立 slug, 抓包结果
 *   - "话题派生" 板块 (id 形如 't<topicId>'): tag 统一用 'topic_<topicId>' 兜底 —
 *     真实 slug 没抓包确认, 推荐流接口失败时 fallback 到 APP tag 路径有概率成功
 *     (sjz 验证过 'topic_611472' 这套约定有效), 不成功则前端弹空页 + tag 错提示
 *
 * verified 区分原则:
 *   - 原参考实现 (vscode-maxPlus 1.5.0, 2026/02) 验证过的 6 个 → verified: true
 *   - 其它都未独立抓 tag 验证 → verified: false, 用户启用后自行验证;
 *     登录态下走 topicId 推荐流通常可用, 未登录态走 APP tag 路径可能空页
 *
 * topicId 来源:
 *   - 原 6 个 + 部分常见游戏: 用户 2026/06 实测抓 link.topics[].topic_id 确认
 *     (具体值见 globalState 字典 'xiaoheihe.topicMap' 导出 + 文档)
 *   - 其余字典补全的 116 项: 来自用户运行时累积的 topicMap 字典硬编码, 让新用户
 *     不依赖运行时累积也能"开箱即用走推荐流". 这部分都用 id='t<topicId>' 命名,
 *     一眼能跟"手维护英文 slug" 板块区分开.
 *
 * 注: 数据量虽大但都是声明式数据, BUILTIN_SECTIONS 默认只承担"反查 topicId" 角色;
 * UI 默认 tab 由 DEFAULT_ENABLED_SECTIONS 决定 (7 个), 其余板块用户在 ⚙ 里勾或
 * 通过 'xiaoheihe.switchToTopic' 命令快速搜索切换.
 */
export const BUILTIN_SECTIONS: readonly XiaoheiheSectionMeta[] = [
  // ============================================================
  // ---- 已验证 (vscode-maxPlus 原版同款 + 用户抓 topicId) ----
  // ============================================================
  // topicId 字段全部已 2026/06 抓包验证 (出现在用户字典里 = 服务端能正常返回 link.topics).
  { id: 'ow',          label: '守望先锋',         tag: 'overwatchtwo',  topicId: '563627', verified: true },
  { id: 'sjz',         label: '三角洲行动',       tag: 'topic_611472',  topicId: '611472', verified: true },
  { id: 'csgo',        label: 'CS:GO',           tag: 'csgo',          topicId: '43',     verified: true },
  { id: 'apex',        label: 'APEX英雄',        tag: 'APEX',          topicId: '57602',  verified: true },
  { id: 'lol',         label: '英雄联盟',         tag: 'lol',           topicId: '55058',  verified: true },
  { id: 'pubg',        label: '绝地求生',         tag: 'PUBG',          topicId: '7216',   verified: true },
  // ============================================================
  // ---- 未验证 (社区高频, tag 猜的; topicId 字典命中后补全) ----
  // ============================================================
  // 这一段 id 是"英文 slug 手维护", 跟下面"话题派生" 段的 't<topicId>' 区分.
  // topicId 都从用户 2026/06 字典里反查出来 (能命中字典 = 服务端真有这个板块).
  { id: 'yuanshen',    label: '原神',             tag: 'yuanshen',      topicId: '68834',  verified: false },
  { id: 'naraka',      label: '永劫无间',         tag: 'naraka',        topicId: '72984',  verified: false },
  { id: 'valorant',    label: '无畏契约',         tag: 'valorant',      topicId: '235709', verified: false },
  { id: 'dota2',       label: 'DOTA2',           tag: 'dota2',         verified: false },
  { id: 'eldenring',   label: '艾尔登法环',       tag: 'eldenring',     topicId: '442871', verified: false },
  { id: 'pubgm',       label: '和平精英',         tag: 'pubgm',         topicId: '21419',  verified: false },
  { id: 'gta5',        label: 'GTA5',            tag: 'gta5',          verified: false },
  { id: 'diablo4',     label: '暗黑破坏神4',      tag: 'diablo4',       topicId: '429033', verified: false },
  { id: 'genshin',     label: '崩坏:星穹铁道',    tag: 'sr',            verified: false },
  { id: 'wuthering',   label: '鸣潮',             tag: 'wuthering',     topicId: '667910', verified: false },

  // ============================================================
  // ---- 话题派生板块 (用户字典硬编码, 共 116 项, 按 topicId 升序) ----
  // ============================================================
  // 来源: 2026/06 用户运行时 'xiaoheihe.topicMap' 字典导出 (含 133 项, 去掉上面 17 项重叠后剩 116).
  // 命名: id='t<topicId>', tag='topic_<topicId>' — 都从 topicId 派生, 没有手维护成本.
  //   - topicId 是真实抓包确认过的 (来自 link.topics[]), 登录态下走推荐流接口 100% 命中
  //   - tag 是按 sjz 那套 'topic_<id>' 约定猜的兜底, 未登录态可能空页, 但不会破坏入参校验
  // verified=false: 这些都没抓独立 tag, 只能算"半验证" (topicId 验证 + tag 推测).
  { id: 't1',       label: 'PC游戏',                       tag: 'topic_1',       topicId: '1',       verified: false },
  { id: 't1210',    label: '僵尸毁灭工程',                  tag: 'topic_1210',    topicId: '1210',    verified: false },
  { id: 't1646',    label: '数字战斗模拟：世界',             tag: 'topic_1646',    topicId: '1646',    verified: false },
  { id: 't1709',    label: '欧洲卡车模拟2',                  tag: 'topic_1709',    topicId: '1709',    verified: false },
  { id: 't1747',    label: '星际战甲',                       tag: 'topic_1747',    topicId: '1747',    verified: false },
  { id: 't1763',    label: '英雄连2',                        tag: 'topic_1763',    topicId: '1763',    verified: false },
  { id: 't1844',    label: '战争雷霆',                       tag: 'topic_1844',    topicId: '1844',    verified: false },
  { id: 't3618',    label: '雨世界',                         tag: 'topic_3618',    topicId: '3618',    verified: false },
  { id: 't3738',    label: '模拟火车：新时代',               tag: 'topic_3738',    topicId: '3738',    verified: false },
  { id: 't5220',    label: '彩虹六号：围攻X',                tag: 'topic_5220',    topicId: '5220',    verified: false },
  { id: 't5457',    label: 'Blender',                       tag: 'topic_5457',    topicId: '5457',    verified: false },
  { id: 't5772',    label: '黑暗之魂3',                      tag: 'topic_5772',    topicId: '5772',    verified: false },
  { id: 't6382',    label: '战术小队',                       tag: 'topic_6382',    topicId: '6382',    verified: false },
  { id: 't6950',    label: '命运石之门',                     tag: 'topic_6950',    topicId: '6950',    verified: false },
  { id: 't6958',    label: '星露谷物语',                     tag: 'topic_6958',    topicId: '6958',    verified: false },
  { id: 't7214',    label: '盒友杂谈',                       tag: 'topic_7214',    topicId: '7214',    verified: false },
  { id: 't11635',   label: 'Wallpaper Engine',              tag: 'topic_11635',   topicId: '11635',   verified: false },
  { id: 't16370',   label: '装机模拟器',                     tag: 'topic_16370',   topicId: '16370',   verified: false },
  { id: 't17268',   label: '骑马与砍杀2：霸主',              tag: 'topic_17268',   topicId: '17268',   verified: false },
  { id: 't17276',   label: '刺客信条：起源',                 tag: 'topic_17276',   topicId: '17276',   verified: false },
  { id: 't18745',   label: '数码硬件',                       tag: 'topic_18745',   topicId: '18745',   verified: false },
  { id: 't18845',   label: '猎杀：对决 1896',                tag: 'topic_18845',   topicId: '18845',   verified: false },
  { id: 't21325',   label: '手机游戏',                       tag: 'topic_21325',   topicId: '21325',   verified: false },
  { id: 't21972',   label: '影视',                           tag: 'topic_21972',   topicId: '21972',   verified: false },
  { id: 't21983',   label: '魔兽世界',                       tag: 'topic_21983',   topicId: '21983',   verified: false },
  { id: 't22892',   label: '王者荣耀',                       tag: 'topic_22892',   topicId: '22892',   verified: false },
  { id: 't23563',   label: '主机游戏',                       tag: 'topic_23563',   topicId: '23563',   verified: false },
  { id: 't23799',   label: '明日方舟',                       tag: 'topic_23799',   topicId: '23799',   verified: false },
  { id: 't23825',   label: 'BanG Dream! 少女乐团派对!',      tag: 'topic_23825',   topicId: '23825',   verified: false },
  { id: 't47779',   label: '黑暗之魂：重制版',               tag: 'topic_47779',   topicId: '47779',   verified: false },
  { id: 't49446',   label: '怪物猎人：世界',                 tag: 'topic_49446',   topicId: '49446',   verified: false },
  { id: 't49557',   label: '刺客信条：奥德赛',               tag: 'topic_49557',   topicId: '49557',   verified: false },
  { id: 't53575',   label: '荒野大镖客：救赎2',              tag: 'topic_53575',   topicId: '53575',   verified: false },
  { id: 't57326',   label: '深海迷航：零度之下',             tag: 'topic_57326',   topicId: '57326',   verified: false },
  { id: 't65410',   label: '命运2',                          tag: 'topic_65410',   topicId: '65410',   verified: false },
  { id: 't65429',   label: '博德之门3',                       tag: 'topic_65429',   topicId: '65429',   verified: false },
  { id: 't65513',   label: '赛博朋克2077',                    tag: 'topic_65513',   topicId: '65513',   verified: false },
  { id: 't66739',   label: 'PS',                             tag: 'topic_66739',   topicId: '66739',   verified: false },
  { id: 't68079',   label: '动漫',                           tag: 'topic_68079',   topicId: '68079',   verified: false },
  { id: 't70761',   label: '十字军之王3',                    tag: 'topic_70761',   topicId: '70761',   verified: false },
  { id: 't73361',   label: '毕业之后',                       tag: 'topic_73361',   topicId: '73361',   verified: false },
  { id: 't73907',   label: '沙雕日常',                       tag: 'topic_73907',   topicId: '73907',   verified: false },
  { id: 't74104',   label: '千恋＊万花',                     tag: 'topic_74104',   topicId: '74104',   verified: false },
  { id: 't77779',   label: '家庭战斗员',                     tag: 'topic_77779',   topicId: '77779',   verified: false },
  { id: 't416158',  label: '情投一盒',                       tag: 'topic_416158',  topicId: '416158',  verified: false },
  { id: 't416618',  label: '战地风云1',                       tag: 'topic_416618',  topicId: '416618',  verified: false },
  { id: 't417657',  label: '雀魂麻将',                       tag: 'topic_417657',  topicId: '417657',  verified: false },
  { id: 't419037',  label: '周边',                           tag: 'topic_419037',  topicId: '419037',  verified: false },
  { id: 't419470',  label: '萌宠',                           tag: 'topic_419470',  topicId: '419470',  verified: false },
  { id: 't425422',  label: 'Steam',                          tag: 'topic_425422',  topicId: '425422',  verified: false },
  { id: 't428481',  label: '电脑集团（测试版）',             tag: 'topic_428481',  topicId: '428481',  verified: false },
  { id: 't428513',  label: '碧蓝档案-日服',                  tag: 'topic_428513',  topicId: '428513',  verified: false },
  { id: 't430505',  label: '仙剑奇侠传三',                   tag: 'topic_430505',  topicId: '430505',  verified: false },
  { id: 't430534',  label: '小说',                           tag: 'topic_430534',  topicId: '430534',  verified: false },
  { id: 't431073',  label: '困兽之国',                       tag: 'topic_431073',  topicId: '431073',  verified: false },
  { id: 't431100',  label: '仙剑奇侠传',                     tag: 'topic_431100',  topicId: '431100',  verified: false },
  { id: 't441867',  label: 'Steam Deck Deposit',             tag: 'topic_441867',  topicId: '441867',  verified: false },
  { id: 't445015',  label: 'Red Dead Redemption',            tag: 'topic_445015',  topicId: '445015',  verified: false },
  { id: 't448724',  label: '怪物猎人：崛起',                 tag: 'topic_448724',  topicId: '448724',  verified: false },
  { id: 't449891',  label: '战神',                           tag: 'topic_449891',  topicId: '449891',  verified: false },
  { id: 't450671',  label: '碧蓝档案',                       tag: 'topic_450671',  topicId: '450671',  verified: false },
  { id: 't454622',  label: '弧光猎人',                       tag: 'topic_454622',  topicId: '454622',  verified: false },
  { id: 't454996',  label: '刺客信条',                       tag: 'topic_454996',  topicId: '454996',  verified: false },
  { id: 't455400',  label: '绘画',                           tag: 'topic_455400',  topicId: '455400',  verified: false },
  { id: 't459272',  label: '微软飞行模拟',                   tag: 'topic_459272',  topicId: '459272',  verified: false },
  { id: 't461250',  label: '游戏王：大师决斗',                tag: 'topic_461250',  topicId: '461250',  verified: false },
  { id: 't475487',  label: '杂谈吐槽',                       tag: 'topic_475487',  topicId: '475487',  verified: false },
  { id: 't475500',  label: 'OW攻略讨论',                     tag: 'topic_475500',  topicId: '475500',  verified: false },
  { id: 't476880',  label: '使命召唤®',                      tag: 'topic_476880',  topicId: '476880',  verified: false },
  { id: 't478674',  label: '鸦卫奇旅',                       tag: 'topic_478674',  topicId: '478674',  verified: false },
  { id: 't484227',  label: '街头霸王6',                       tag: 'topic_484227',  topicId: '484227',  verified: false },
  { id: 't486313',  label: '生化危机4 重制版',                 tag: 'topic_486313',  topicId: '486313',  verified: false },
  { id: 't486620',  label: '犹格索托斯的庭院',               tag: 'topic_486620',  topicId: '486620',  verified: false },
  { id: 't486783',  label: '铁拳8',                          tag: 'topic_486783',  topicId: '486783',  verified: false },
  { id: 't549999',  label: '校园生活',                       tag: 'topic_549999',  topicId: '549999',  verified: false },
  { id: 't550000',  label: '职场工作',                       tag: 'topic_550000',  topicId: '550000',  verified: false },
  { id: 't563101',  label: '万词破 - 单词女友 WCP Word',      tag: 'topic_563101',  topicId: '563101',  verified: false },
  { id: 't564905',  label: '5050',                           tag: 'topic_564905',  topicId: '564905',  verified: false },
  { id: 't568547',  label: '黑神话：悟空',                   tag: 'topic_568547',  topicId: '568547',  verified: false },
  { id: 't570910',  label: 'WRC',                            tag: 'topic_570910',  topicId: '570910',  verified: false },
  { id: 't581822',  label: '侠盗猎车手 6',                    tag: 'topic_581822',  topicId: '581822',  verified: false },
  { id: 't583653',  label: '怪物猎人：荒野',                 tag: 'topic_583653',  topicId: '583653',  verified: false },
  { id: 't590409',  label: '逆战：未来',                     tag: 'topic_590409',  topicId: '590409',  verified: false },
  { id: 't590990',  label: '学生时代',                       tag: 'topic_590990',  topicId: '590990',  verified: false },
  { id: 't600812',  label: '天国：拯救2',                    tag: 'topic_600812',  topicId: '600812',  verified: false },
  { id: 't600897',  label: '暗区突围：无限（PC）',           tag: 'topic_600897',  topicId: '600897',  verified: false },
  { id: 't610368',  label: '真・三国无双 起源',              tag: 'topic_610368',  topicId: '610368',  verified: false },
  { id: 't615783',  label: '游戏开发',                       tag: 'topic_615783',  topicId: '615783',  verified: false },
  { id: 't632593',  label: '无主之地4',                       tag: 'topic_632593',  topicId: '632593',  verified: false },
  { id: 't640844',  label: '荒野大镖客：救赎',               tag: 'topic_640844',  topicId: '640844',  verified: false },
  { id: 't642313',  label: 'Subnautica 2：异星水域',         tag: 'topic_642313',  topicId: '642313',  verified: false },
  { id: 't643838',  label: '失落星船：马拉松',               tag: 'topic_643838',  topicId: '643838',  verified: false },
  { id: 't647773',  label: '刺客信条：影',                   tag: 'topic_647773',  topicId: '647773',  verified: false },
  { id: 't651390',  label: '逃离鸭科夫',                     tag: 'topic_651390',  topicId: '651390',  verified: false },
  { id: 't651663',  label: '艾尔登法环 黑夜君临',             tag: 'topic_651663',  topicId: '651663',  verified: false },
  { id: 't651702',  label: '鬼武者：剑之道',                  tag: 'topic_651702',  topicId: '651702',  verified: false },
  { id: 't658481',  label: '追曙',                           tag: 'topic_658481',  topicId: '658481',  verified: false },
  { id: 't660778',  label: 'R.E.P.O.',                       tag: 'topic_660778',  topicId: '660778',  verified: false },
  { id: 't661934',  label: '剑星',                           tag: 'topic_661934',  topicId: '661934',  verified: false },
  { id: 't668697',  label: 'F1® 25',                         tag: 'topic_668697',  topicId: '668697',  verified: false },
  { id: 't670476',  label: '燕云十六声',                     tag: 'topic_670476',  topicId: '670476',  verified: false },
  { id: 't679883',  label: '识质存在',                       tag: 'topic_679883',  topicId: '679883',  verified: false },
  { id: 't679891',  label: '胜利女神：新的希望',             tag: 'topic_679891',  topicId: '679891',  verified: false },
  { id: 't686823',  label: 'NBA 2K26',                       tag: 'topic_686823',  topicId: '686823',  verified: false },
  { id: 't687991',  label: 'EA SPORTS FC™ 26',               tag: 'topic_687991',  topicId: '687991',  verified: false },
  { id: 't702066',  label: '战地风云™ 6',                    tag: 'topic_702066',  topicId: '702066',  verified: false },
  { id: 't712538',  label: '足球经理26',                     tag: 'topic_712538',  topicId: '712538',  verified: false },
  { id: 't714349',  label: '逃离塔科夫',                     tag: 'topic_714349',  topicId: '714349',  verified: false },
  { id: 't716382',  label: '极限竞速：地平线 6',             tag: 'topic_716382',  topicId: '716382',  verified: false },
  { id: 't717591',  label: '刺客信条IV：黑旗',                tag: 'topic_717591',  topicId: '717591',  verified: false },
  { id: 't719027',  label: '宝可梦Pokopia',                  tag: 'topic_719027',  topicId: '719027',  verified: false },
  { id: 't722821',  label: '四合 Quadrangle',                tag: 'topic_722821',  topicId: '722821',  verified: false },
  { id: 't737442',  label: '罪金游戏',                       tag: 'topic_737442',  topicId: '737442',  verified: false },
  { id: 't756571',  label: '女王的游戏：盛世天下 女帝篇',     tag: 'topic_756571',  topicId: '756571',  verified: false },
  { id: 't756617',  label: '盛世天下：女帝篇',               tag: 'topic_756617',  topicId: '756617',  verified: false },
  { id: 't756734',  label: '守望先锋®',                      tag: 'topic_756734',  topicId: '756734',  verified: false },
  { id: 't758884',  label: '刺客信条:黑旗 记忆重置',          tag: 'topic_758884',  topicId: '758884',  verified: false },
  { id: 't759761',  label: '地球Online',                     tag: 'topic_759761',  topicId: '759761',  verified: false },
  { id: 't767376',  label: '漫威金刚狼',                     tag: 'topic_767376',  topicId: '767376',  verified: false },
  { id: 't768116',  label: 'Stellar Blade: BLOOD',           tag: 'topic_768116',  topicId: '768116',  verified: false },
] as const;

/**
 * @deprecated 旧名, 仅原始 6 个游戏; 新代码用 BUILTIN_SECTIONS / getAllSections.
 *
 * 保留这个数组是因为 XiaoheiheClient.fetchFeed 早期版本按 GAMES.find(id) 校验, 临时兼容;
 * 一旦 client 也改到 SectionMeta 后这里可以删.
 */
export const GAMES = BUILTIN_SECTIONS.filter((s) =>
  ['ow', 'sjz', 'csgo', 'apex', 'lol', 'pubg'].includes(s.id),
);

/**
 * 默认启用的板块 id 列表 (新用户第一次打开看到的 tab).
 *
 * 默认全勾 6 个已验证的 + home; 未验证的让用户自己去 ⚙ 勾, 避免新用户首屏出空 tab.
 */
export const DEFAULT_ENABLED_SECTIONS: readonly XiaoheiheSectionId[] = [
  HOME_SECTION_ID,
  'ow', 'sjz', 'csgo', 'apex', 'lol', 'pubg',
];

/**
 * 服务端原始 link 对象 (经验子集, 不完整).
 *
 * 关键字段说明 (字段名按 2026/06 抓包):
 *   - content_type:   1=普通帖子, 10=头部专题工具栏 (跳过)
 *   - linkid:         数字 id (注意不是 share_url 里的 link_id hash)
 *                     用 number 但传给前端 / 内部去重时统一转 string
 *   - title:          标题, 文字
 *   - description:    摘要, 可能为空; 视频/直播类经常空
 *   - has_video:      1 表示视频帖
 *   - imgs / thumbs:  封面图数组, 优先 imgs[0], 兜底 thumbs[0]
 *   - post_tag:       作者昵称 (字段名很迷)
 *   - formated_time:  服务端已格式化的相对时间字符串, 客户端直接展示
 *   - modify_at:      秒级 timestamp 兜底 (formated_time 缺失时自己格式化)
 *   - hashtags:       话题标签数组 [{name, hashtag_id}], 我们取第 0 个
 *   - share_url:      完整分享 URL, 直接给前端跳浏览器
 *   - comment_num:    评论数
 *   - link_award_num: 点赞数
 */
export interface XiaoheiheRawLink {
  content_type?: number;
  linkid?: number | string;
  title?: string;
  description?: string;
  has_video?: number;
  imgs?: string[];
  thumbs?: string[];
  post_tag?: string;
  formated_time?: string;
  modify_at?: number;
  hashtags?: Array<{ name?: string; hashtag_id?: number }>;
  share_url?: string;
  comment_num?: number;
  link_award_num?: number;
  /**
   * 该 link 关联的"板块/话题" 元信息数组 (2026/06 抓单板块 feeds 响应确认).
   *
   * 每条帖子可能挂多个板块 (例如同一篇守望先锋视频既挂"守望先锋" 又挂"PC游戏"),
   * 服务端在 link 维度自带完整 topic 元信息 (topic_id / name / pic_url / app_id / game_type)
   * — 这是我们"零成本自动发现 topicId" 的数据源:
   *
   *   feeds 响应 → 每条 link.topics[] → 旁路累积到 globalState 'xiaoheihe.topicMap'
   *
   * 跟 hashtags 区别:
   *   - hashtags: 话题标签 (UI 角标用, hashtag_id 不能打 topic/feeds 接口)
   *   - topics:   板块/游戏圈 (topic_id 可直接打 /bbs/app/topic/feeds 拉推荐流)
   */
  topics?: XiaoheiheRawTopic[];
  /** 服务端可能塞的其他字段, 一律保留不读 */
  [key: string]: unknown;
}

/**
 * 服务端 link.topics[] 单元素的字段子集 (2026/06 抓包确认).
 *
 * 字段命名按 web 协议响应原样保留 (snake_case), 进入插件层的 globalState 字典前
 * 经 XiaoheiheClient.extractTopicsFromLinks 归一化成 XiaoheiheTopicMeta (camelCase).
 */
export interface XiaoheiheRawTopic {
  /** 板块数字 id, 可直接打 /bbs/app/topic/feeds?topic_id= */
  topic_id?: number | string;
  /** 板块中文名 (用作 globalState 字典 key) */
  name?: string;
  /** 板块封面图 (UI 展示用) */
  pic_url?: string;
  /** 关联 Steam appid (PC 游戏才有, 主机/手游缺) */
  app_id?: number;
  /** 平台类型: 'pc' / 'console' / 'mobile' / ... */
  game_type?: string;
  /** 服务端打的热度分 (排序参考, 业务用不上) */
  hot_value_v2?: number;
  [key: string]: unknown;
}

/**
 * 板块/话题元信息 (插件层归一化版本, 写入 globalState 'xiaoheihe.topicMap').
 *
 * 跟 XiaoheiheRawTopic 的差异:
 *   - 字段名 camelCase (跟插件层其他类型对齐)
 *   - topicId 强制 string (跟 XiaoheiheSectionMeta.topicId 类型对齐)
 *   - 只保留业务可能用到的字段, 服务端排序分等丢弃
 *
 * globalState 存储结构: Record<topicName, XiaoheiheTopicMeta>
 *   key 用 topic.name (中文名), 因为 fetchFeed 反查时只能拿到 section.label 中文名
 *   (section.tag 是 'overwatchtwo' 这种英文 slug, 跟 topic.name 不对齐, 不能做主键).
 */
export interface XiaoheiheTopicMeta {
  topicId: string;
  name: string;
  picUrl?: string;
  appId?: number;
  gameType?: string;
}

/**
 * globalState 存放"运行时自动发现的板块 topicId 字典" 的 key.
 *
 * 累积时机: 每次 fetchTopicRecommendFeed / fetchRecommendFeed / fetchHomeFeed 返回
 * link 数组后, 旁路扫描 link.topics[] 把 (name → meta) 写进字典. fetchFeed 找不到
 * 硬编码 topicId 时反查这个字典作为 fallback — 用户用得越多, 字典越完整, 越多板块
 * 自动获得"推荐流" 待遇.
 *
 * 字典只增不减 (除非用户手动清, 见 xiaoheihe.clearTopicMap 命令, 待加): 板块下线
 * 的概率极低, 即使下线了用旧 topicId 打接口最坏也就是返回空, fetchFeed 自动 fallback
 * 老 APP tag 路径.
 */
export const TOPIC_MAP_STORAGE_KEY = 'xiaoheihe.topicMap';

/** /bbs/app/feeds/news 的响应外壳 */
export interface XiaoheiheNewsResponse {
  /** 业务 code, 'ok' 或 0 表示成功; 其它走 msg/message 报错 */
  status?: string | number;
  msg?: string;
  message?: string;
  result?: {
    /** 主体: 资讯列表 */
    links?: XiaoheiheRawLink[];
    /** 服务端是否提示已到底; 经验上不总是给, 我们以 links 是否为空兜底判断 */
    is_end?: boolean | number;
  };
}

/**
 * 经过本地归一化、专门给 webview 渲染的 card.
 *
 * 同 zhihu 模块原则一致: 前端不感知"is_video=1 时要换显示样式"这种业务规则,
 * 这一层把所有 raw 字段揉成视图可直接用的字段.
 */
export interface XiaoheiheCardForView {
  /** linkid 字符串形式, 前端去重 + 跳详情 url 拼接 */
  linkId: string;
  /** 标题 */
  title: string;
  /** 摘要 (纯文本, 已剥 HTML; 空则不渲染) */
  excerpt: string;
  /** 封面图 url (https), 没有则空字符串, 前端按需隐藏 */
  cover: string;
  /** 作者名 (没有则空) */
  authorName: string;
  /** 子标签, 形如 "新闻" / "攻略"; 没有则空, 前端隐藏 */
  linkTag: string;
  /** 是否视频帖, 视频帖在卡片角标显示 ▶ */
  isVideo: boolean;
  /** 发布时间, 已格式化成 "x 小时前" / "yyyy-MM-dd" 这种 (本地化由后端做完发给前端) */
  publishedAt: string;
  /** 评论数 (0 表示无, 前端按需隐藏) */
  commentCount: number;
  /** 点赞数 (0 表示无) */
  awardCount: number;
  /**
   * 详情 url — 用于在浏览器中打开 / 后续如果做内嵌阅读也复用这个.
   *
   * 直接用服务端 raw.share_url, 形如:
   *   https://api.xiaoheihe.cn/v3/bbs/app/api/web/share?h_camp=link&h_src=...&link_id=<hash>
   * 注意末尾 link_id 是 hash 字符串 (不是数字 linkid), 服务端 302 到最终 h5 详情页.
   * 不要自己拼这个 URL — 没有 share token 接服务端会 403.
   */
  shareUrl: string;

  /**
   * 卡片来源板块 id — 主页混排时用. 普通板块拉的卡片就是该板块本身, 主页 (home) 拉的
   * 卡片回填为"实际来源板块"(round-robin 取自的子板块). 空字符串表示未知/不展示.
   * 仅作 UI 角标 ("来自 守望先锋") 用, 不影响业务逻辑.
   */
  sourceSectionId?: string;
  /** 卡片来源板块 label (中文短名), 配合 sourceSectionId 渲染角标 */
  sourceSectionLabel?: string;
}

/**
 * 卡片就地展开后的"详情视图"数据 (走 /bbs/app/link/tree page=1 limit=1).
 *
 * 设计上有意保持很薄: 小黑盒帖子普遍短 (几百字内, 大多是配图水帖), 不像知乎长答案
 * 那样需要分段切片. 所以这里就给"全文 + 图片", webview 一次性渲染.
 */
export interface XiaoheiheDetailForView {
  /** 跟 card.linkId 一致, 用于路由展开/折叠 + 评论翻页 */
  linkId: string;
  /**
   * 正文文本 (已剥 HTML, 保留段落换行), 含 `[IMG:url]` 占位符表示正文里嵌入的图.
   *
   * 处理来源:
   *   1) link.description 里的 <img src> -> [IMG:url] 占位符 (按出现位置原位保留)
   *   2) link.imgs / link.thumbs 里 description 没出现过的图 -> append 到末尾
   *      (每行一个 [IMG:url], 跟正文之间空一行)
   *
   * 前端 renderTextWithImages 把 [IMG:url] 切片成 <img> (开关开) / 占位 span (关).
   * 空字符串 = 帖子无正文且无图.
   */
  contentText: string;
  /**
   * 全部图 URL 数组 (description 解析 + raw.imgs/thumbs 兜底, 去重后).
   *
   * v2.2.1 起前端不直接渲染这个数组 — 所有图都通过 contentText 里的 [IMG:url]
   * 占位符在原位渲染, 这样图片显示开关可以统一控制. 字段保留用于上层做"图片张数"
   * 之类的统计, 删它会破坏类型契约, 索性留着.
   */
  contentImgs: string[];
  /** 评论总数 (服务端 link.comment_num), 给 "查看评论 (N)" 按钮显示 */
  commentCount: number;
  /** 总楼层数 (服务端 result.total_floor_num), 用于评论分页"已加载 a/b 楼"提示 */
  totalFloor: number;
}

/**
 * 单条评论的视图数据 (主评论 + 楼中楼共用同一个类型).
 *
 * 服务端结构: result.comments[i].comment 是数组, [0] 是主评论, [1..] 是楼中楼
 * 预加载片段 (只给前几条, child_num 是楼中楼总数, has_more 标记是否还有更多).
 *
 * 归一化时:
 *   - 主评论会把 [1..] 转成同类型放进 children, 在 UI 上缩进展示
 *   - 楼中楼自身的 children 一定是空数组 (服务端不会嵌套两层楼中楼; 即使有, 我们
 *     按业务上不存在处理 — 跟 zhihu/B站二级评论模型一致)
 *   - hasMoreChildren = children.length < childNum, 表示有剩余子评论未下发,
 *     UI 上挂"查看更多回复 (X/N)"按钮, 点击走 fetchSubCommentsPage 继续游标分页.
 */
export interface XiaoheiheCommentForView {
  /** 评论 id (前端去重 + 后续翻子评论用) */
  commentId: string;
  /** 评论者用户名 */
  username: string;
  /** 头像 url (https), 空则前端用占位 */
  avatar: string;
  /** 用户等级 (没有则 0, 前端不显示) */
  level: number;
  /** 评论文本 (服务端给的就是纯文本, 含表情占位符如 [cube_哭泣]) */
  text: string;
  /** 楼层号, 0 表示置顶 (服务端给 floor_num=0/is_top=1 表示置顶楼) */
  floorNum: number;
  /** 点赞数 */
  up: number;
  /** IP 属地 ("湖北" / "陕西"); 空则前端隐藏 */
  ipLocation: string;
  /** 子评论总数 (服务端 child_num), 含未下发的; UI 用来跟 children.length 对比 */
  childNum: number;
  /** 是否置顶 (官方/楼主置顶) */
  isTop: boolean;
  /**
   * 楼中楼 (子评论) 列表. 仅主评论可能非空; 楼中楼自身的 children 总是空数组.
   * 来自服务端预加载片段 result.comments[i].comment[1..], 不再发请求.
   */
  children: XiaoheiheCommentForView[];
  /**
   * 是否还有未下发的子评论 (childNum > children.length).
   * UI 上显示 "查看更多回复 (X/N)" 按钮, 点击走 /bbs/app/comment/sub/comments
   * 接口游标分页继续拉.
   */
  hasMoreChildren: boolean;
}

/**
 * 子评论分页响应 (/bbs/app/comment/sub/comments).
 *
 * 协议特点:
 *   - 游标分页, 不是 page+limit. lastVal 传 "上一批最后一条的 commentid",
 *     服务端返回严格大于该游标的下一批 (首次请求 = 已展示的最后一条 commentid).
 *   - 锚定 rootCommentId (主评论 id), linkId 当前抓包未观察到必填 — 防御性保留.
 *   - 不嵌套楼中楼 (子评论本身不再有 children), 响应里的 comments 是扁平数组.
 *
 * 字段约定:
 *   - lastVal 是 string (服务端 commentid 可能很大, 别用 number 防精度丢失)
 *   - hasMore false 表示已无更多, 前端把按钮收起来
 */
export interface XiaoheiheSubCommentsPage {
  /** 本批子评论 (扁平, children 必为空) */
  comments: XiaoheiheCommentForView[];
  /** 下次请求要传的 lastVal (本批最后一条 commentid). 已无更多时仍可携带, 前端按 hasMore 决定要不要再请求 */
  nextLastVal: string;
  /** 是否还有更多 */
  hasMore: boolean;
}

/**
 * 评论翻页响应 (调用方维护 page 推进).
 *
 * 翻页约定: page 从 1 起步 (跟服务端一致, 不要 0); hasMore=false 表示已到底.
 */
export interface XiaoheiheCommentsPage {
  /** 本页评论 */
  comments: XiaoheiheCommentForView[];
  /** 本次请求的 page (echo, 方便前端按 reqId 路由) */
  page: number;
  /** 总页数 (服务端 total_page), 仅用于显示, 翻页决策看 hasMore */
  totalPage: number;
  /** 是否还有下一页 (= has_more_floors === 1) */
  hasMore: boolean;
}

/**
 * /bbs/app/link/tree 的响应外壳 — 服务端字段比 feeds/news 多, 这里只声明用到的子集.
 *
 * result.link:      帖子正文 (XiaoheiheRawLink 的超集, 多了 description 完整版)
 * result.comments:  评论楼层数组, 每项 { comment: RawComment[] } —
 *                   comment[0] 是主评论, comment[1..] 是楼中楼 (v1 不展开)
 * result.total_page / has_more_floors / total_floor_num: 评论分页相关
 */
export interface XiaoheiheLinkTreeResponse {
  status?: string | number;
  msg?: string;
  message?: string;
  result?: {
    link?: XiaoheiheRawLink;
    /** 评论楼层数组, 注意是 [{ comment: [...] }, ...] 嵌套结构 */
    comments?: Array<{ comment?: XiaoheiheRawComment[] }>;
    total_page?: number;
    has_more_floors?: number | boolean;
    total_floor_num?: number;
  };
}

/**
 * 服务端 result.comments[i].comment[j] 的字段 (经验子集).
 *
 * j=0 是主评论, j>=1 是楼中楼 (回复主评论的). v1 只取 j=0 渲染主楼层.
 */
export interface XiaoheiheRawComment {
  commentid?: number | string;
  text?: string;
  up?: number;
  floor_num?: number;
  is_top?: number;
  child_num?: number;
  has_more?: number;
  ip_location?: string;
  user?: {
    username?: string;
    avatar?: string;
    avartar?: string; // 服务端字段拼写错误版本 (sic), 兜底
    level_info?: { level?: number };
  };
  [key: string]: unknown;
}

/**
 * 小黑盒 cookie 解析结果.
 *
 * 关键字段:
 *   - pkey:     登录鉴权 token, 没这个就是未登录态 — 业务接口 signedGet 注入到 Cookie header
 *   - heyboxId: 用户数字 ID, 注入到 signedGet 的 heybox_id 字段 (替代未登录占位 '-1')
 *   - rawCookie: 原始 cookie 字符串, signedGet 从这里白名单过滤后注入到 Cookie header
 *                (鉴权字段 pkey/heybox_id 及其 httpOnly 副本)
 *
 * v2.2.4 起 web hkey 走本地算法 (utils/webSign.ts), 不再需要持久化 webSig (历史
 * 字段已删, v2.2.3 老用户的 JSON 持久化在 AuthService.initialize 里向后兼容读取
 * cookie 字段, webSig 段直接丢弃).
 *
 * AuthService.getJar() 返回; 未登录返回 null.
 */
export interface XiaoheiheCookieJar {
  pkey?: string;
  heyboxId?: string;
  rawCookie: string;
}
