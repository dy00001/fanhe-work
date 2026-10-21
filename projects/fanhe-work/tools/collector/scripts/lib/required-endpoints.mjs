/**
 * 每页「必须拿到」的接口。
 *
 * 为什么需要它：`isThin` 只看文件数与总字节，一页只要回了心跳 + 一个大响应就算
 * 「不薄」。flow-shopsource 在 10-19 正是这样 —— 2 个文件、字节数够，但渠道树那个
 * 接口根本没发请求，于是采集判定通过、导出层认不出渠道、看板渠道一片「—」，而采集
 * 日志是绿的。体量够不等于内容对。
 *
 * 采集端与校验端共用这一份，避免「采集按 A 判、校验按 B 判」—— 那等于没有判据。
 */

export const REQUIRED_ENDPOINTS = {
  'flow-overview': /overview\.json/i,
  'flow-shopsource': /tree_platform_support/i,
  'flow-visitor': /listareas/i,
  'flow-keyword': /drainagesearch/i,
  'item-rank': /item_view_top/i,
  'trade-detail': /gettendency/i,
}

/**
 * 返回缺失的接口特征（正则源码数组）。没有声明要求的页面返回空数组。
 *
 * `saved` 是 manifest 里的落盘记录，每项至少有 `file`，通常也有 `url`。
 * 两个都试，因为同一接口在不同页面可能只留下其中一个。
 */
export function missingEndpoints(pageName, saved) {
  const pattern = REQUIRED_ENDPOINTS[pageName]
  if (pattern === undefined) return []
  const list = Array.isArray(saved) ? saved : []
  const hit = list.some(
    (entry) => pattern.test(entry?.url ?? '') || pattern.test(entry?.file ?? ''),
  )
  return hit ? [] : [pattern.source]
}
