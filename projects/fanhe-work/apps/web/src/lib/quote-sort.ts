/**
 * 拖动排序的纯计算。
 *
 * 这一屏有三个列表要允许拖动（分类 / 产品 / 主类），三处的落点算法必须是同一份 ——
 * 各写一遍的话，`from < insert` 那一句只要有一处漏了「移除后下标左移」，表现就是
 * 「往下的拖动差一位」，而这种错误在界面上看起来像「偶尔不灵」。
 *
 * 放在纯函数里还有一个好处：这套下标算术在组件里根本测不了，只能靠手点，而手点
 * 永远只会点那一两个方向。
 */

/** 一行在拖动中的落点：拖到 `over` 这一行的上半 → 插在它前面；下半 → 插在它后面。 */
export type DropTarget = {
  /** 拖动起点（原下标）。 */
  from: number
  /** 光标所在行（当前列表的下标）。 */
  over: number
  /** 是否落在 `over` 的下半部分（= 插在它后面）。 */
  after: boolean
}

/**
 * 光标是否落在这一行的下半部分。
 *
 * 用**半高**判据而不是「离上边缘多近」：列表每行高度不一定相同（产品行有两行文字），
 * 固定像素阈值在矮行上会让整个下半区都算「前面」。
 */
export function isAfterMidpoint(rectTop: number, rectHeight: number, clientY: number): boolean {
  return clientY > rectTop + rectHeight / 2
}

/**
 * 按落点算出新顺序。返回**新数组**，不改入参。
 *
 * ## 为什么要有 `from < insert` 那一句
 *
 * `splice(from, 1)` 之后，原本在 `from` 后面的元素全体左移一位。如果落点在拖动起点
 * **之后**，那么按原台下算出来的插入下标已经多了一格 —— 不减去这一格，往下拖永远
 * 差一位（拖到第 4 行会落在第 3 行）。
 *
 * ## 拖到自己身上是空操作
 *
 * `from === over` 直接返回原样。不这么写的话，「点在原地松手」会被算成挪到自己的
 * 上半或下半，然后发一次没有意义的写请求。
 */
export function applyDrop<T>(items: readonly T[], target: DropTarget): T[] {
  const next = [...items]
  const { from, over, after } = target
  if (from === over) return next
  if (from < 0 || from >= next.length || over < 0 || over >= next.length) return next

  // 先移除、再算插入位。顺序反过来就要做一次「落点在起点之后则减一」的补偿，
  // 而那个补偿正是最容易漏掉的一句。
  const removed = next.splice(from, 1)
  const moved = removed[0]
  if (moved === undefined) return [...items]

  let insert = after ? over + 1 : over
  if (from < insert) insert -= 1
  if (insert < 0) insert = 0
  // 移除之后合法插入位是 0..next.length（含右端，等于追加到末尾）。
  if (insert > next.length) insert = next.length

  next.splice(insert, 0, moved)
  return next
}

/**
 * 两份顺序是不是一模一样。
 *
 * 用来省掉「原地松手」的写请求：拖动常常落在原位置（尤其按住的是一个已经在该位置
 * 的行），而产品重排一次会改写整段几百行。
 */
export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}
