import { inflateRawSync, inflateSync } from 'node:zlib'

import {
  QUOTE_LIMITS,
  type QuoteImportFailure,
  type QuoteImportFormat,
  type QuoteImportRow,
  type QuoteSource,
} from '@fanhe/shared'

/**
 * 批量导入的内置识别器。
 *
 * ## 为什么自己解析 xlsx，不引一个库
 *
 * xlsx 就是一个 zip，里面是几张 XML。这个仓库的依赖表很短，为了读「第一个 sheet
 * 的单元格文本」引一个几 MB 的解析库不划算 —— 而真正需要的只有两件事：读
 * `sharedStrings.xml`、按行读 `sheet1.xml` 的 `<c>`。手写这两段的成本远低于
 * 一次依赖升级带来的回归面。
 *
 * 代价是**只支持单 sheet、只读值不读样式、不处理 zip64**。产品台账正好落在这个
 * 范围里（三份台账都是单 sheet 的价格表，最大的 300KB）。
 *
 * ## PDF 是「尽力而为」，不是「支持」
 *
 * PDF 里没有「表格」这个概念，只有画在页面上的文字与线条。文本型 PDF 能抽出文字，
 * 但**列位置会丢** —— 抽出来的是「柜体门板 18mm 颗粒板 668 ㎡」这样一串。扫描件
 * 更是只有图。所以 PDF 走一条降级路径：抽得出可读文本就按行切、按位置猜列，并
 * 在文件级警告里写明「列可能串行，请逐条核对」；抽不出就直说「请另存为 Excel」，
 * 而不是拿一堆乱码冒充识别结果。
 *
 * ## 识别与写库是分开的两步
 *
 * 这里只产出「行」，一行都不写库。写库在 `applyImportRows`，操作员在确认页里改完
 * 之后才调用。理由很实际：识别一定会出错（合并单元格、跨行备注、表头多一行空行），
 * 而**导入是不可逆的**（1225 条里改错一批，回滚要重跑整份台账）。
 */

export type ParseFailure = { ok: false; reason: QuoteImportFailure; message: string }

/**
 * 识别出来的一行：产品字段 + 源文件行号 + 逐行提示。
 *
 * 行号必须由识别器给，不能让调用方按下标推算 —— 中间跳过的空行、合计行、重复表头
 * 都会让下标与源文件错位，而「按行号回原表核对」正是确认页唯一的纠错手段。
 */
export type ParsedRow = QuoteImportRow & { sourceLine: number; warnings: string[] }

export type ParseSuccess = {
  ok: true
  value: {
    format: QuoteImportFormat
    rows: ParsedRow[]
    warnings: string[]
    detectedColumns: string[]
    suggestedSource: QuoteSource | null
  }
}

export type ParseResult = ParseSuccess | ParseFailure

// ---------------------------------------------------------------------------
// 格式判定
// ---------------------------------------------------------------------------

/**
 * 按魔数判，不信扩展名。
 *
 * 与图片上传同一条判断：声明一个与字节不符的类型不会有任何报错，只会让后面的解析
 * 在莫名其妙的地方失败（例如把一个 PDF 当 xlsx 解压，报「不是 zip」）。
 */
export function detectFormat(fileName: string, bytes: Uint8Array): QuoteImportFormat | null {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03) {
    return 'xlsx'
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  ) {
    return 'pdf'
  }
  // 文本类没有魔数，只能看扩展名，并且要能解成文本。
  if (/\.(csv|txt|tsv)$/i.test(fileName)) return 'csv'
  if (/\.xlsx?$/i.test(fileName)) return 'xlsx'
  if (/\.pdf$/i.test(fileName)) return 'pdf'
  return null
}

// ---------------------------------------------------------------------------
// xlsx
// ---------------------------------------------------------------------------

/** 解 zip 的目录表，返回「条目名 → 解压后的字节」。 */
function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // EOCD 在文件尾部，注释最长 65535 字节，所以最多往回找 22 + 65535。
  let eocd = -1
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65557); index -= 1) {
    if (view.getUint32(index, true) === 0x06054b50) {
      eocd = index
      break
    }
  }
  if (eocd === -1) throw new Error('找不到 zip 目录，可能不是 xlsx')

  const count = view.getUint16(eocd + 10, true)
  let offset = view.getUint32(eocd + 16, true)
  const entries = new Map<string, Uint8Array>()

  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) break
    const method = view.getUint16(offset + 10, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const localOffset = view.getUint32(offset + 42, true)
    const name = new TextDecoder('utf-8').decode(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
    )

    // 本地头里的 extra 长度可能与目录表不同，必须以本地头为准 —— 用目录表的值去
    // 算数据起点，会在某些写入器产出的文件上偏移几个字节，表现为「解压出来是乱码」。
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const raw = bytes.subarray(dataStart, dataStart + compressedSize)

    try {
      entries.set(name, method === 0 ? raw : new Uint8Array(inflateRawSync(raw)))
    } catch {
      // 单个条目坏了不该让整份文件失败：缺 sharedStrings 还能退化成 inlineStr。
    }

    offset += 46 + nameLength + extraLength + commentLength
  }

  return entries
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, '&')
}

/** `A` → 0，`AA` → 26。 */
function columnIndex(ref: string): number {
  let value = 0
  for (const char of ref) {
    const code = char.charCodeAt(0)
    if (code < 65 || code > 90) return -1
    value = value * 26 + (code - 64)
  }
  return value - 1
}

function parseSharedStrings(xml: string): string[] {
  const items: string[] = []
  const siPattern = /<si\b[^>]*>([\s\S]*?)<\/si>/g
  let match: RegExpExecArray | null
  while ((match = siPattern.exec(xml)) !== null) {
    const texts: string[] = []
    const textPattern = /<t\b[^>]*>([\s\S]*?)<\/t>/g
    let text: RegExpExecArray | null
    while ((text = textPattern.exec(match[1]!)) !== null) texts.push(decodeXml(text[1]!))
    items.push(texts.join(''))
  }
  return items
}

/**
 * 读一张 sheet 的所有行。
 *
 * 返回二维数组，列按 `r="A1"` 的字母位定位 —— **不能按出现顺序 push**：xlsx 会
 * 跳过空单元格（`<c r="C5">` 前面可能没有 A、B），按顺序 push 会让整行的列全部
 * 左移，而界面上看起来只是「分类跑到了名称那列」。
 */
function parseSheet(xml: string, shared: readonly string[]): string[][] {
  const rows: string[][] = []
  const rowPattern = /<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g
  let rowMatch: RegExpExecArray | null

  while ((rowMatch = rowPattern.exec(xml)) !== null) {
    const body = rowMatch[1]
    if (body === undefined) {
      rows.push([])
      continue
    }

    const cells: string[] = []
    const cellPattern = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
    let cellMatch: RegExpExecArray | null
    while ((cellMatch = cellPattern.exec(body)) !== null) {
      const attrs = cellMatch[1] ?? ''
      const inner = cellMatch[2] ?? ''
      const ref = /\br="([A-Z]+)\d*"/.exec(attrs)?.[1] ?? ''
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? 'n'
      const index = ref === '' ? cells.length : columnIndex(ref)
      if (index < 0) continue

      const rawValue = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? ''
      let value: string
      if (type === 's') value = shared[Number(rawValue)] ?? ''
      else if (type === 'inlineStr') {
        value = decodeXml(/<t\b[^>]*>([\s\S]*?)<\/t>/.exec(inner)?.[1] ?? '')
      } else if (type === 'str') value = decodeXml(rawValue)
      else if (type === 'b') value = rawValue === '1' ? 'TRUE' : 'FALSE'
      else value = decodeXml(rawValue)

      cells[index] = value.trim()
    }

    // 稀疏数组里的空洞补成空串，否则下游 `row.map` 会跳过它们。
    for (let index = 0; index < cells.length; index += 1) cells[index] ??= ''
    rows.push(cells)
  }

  return rows
}

function parseXlsx(bytes: Uint8Array): { matrix: string[][]; sheetName: string } {
  const entries = readZip(bytes)
  const decoder = new TextDecoder('utf-8')

  const sharedEntry = entries.get('xl/sharedStrings.xml')
  const shared = sharedEntry === undefined ? [] : parseSharedStrings(decoder.decode(sharedEntry))

  // 取第一张 sheet。`workbook.xml` 里有顺序与 rId，但真实台账只有一张表 ——
  // 为了它多写一层 rId → target 的映射，收益不抵风险。
  const sheetEntry =
    entries.get('xl/worksheets/sheet1.xml') ??
    [...entries.entries()].find(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))?.[1]

  if (sheetEntry === undefined) throw new Error('这个 xlsx 里没有工作表')

  return {
    matrix: parseSheet(decoder.decode(sheetEntry), shared),
    sheetName: 'sheet1',
  }
}

// ---------------------------------------------------------------------------
// csv
// ---------------------------------------------------------------------------

/**
 * CSV 切分。支持双引号包裹、引号内换行与 `""` 转义。
 *
 * 不用 `split(',')`：备注列里几乎一定有逗号（「含五金，不含台面」），一次 split
 * 会让整行右移，而错位之后每一列都还能读出一个值 —— 只是全错，且不报错。
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
    } else if (char === ',' || char === '\t') {
      row.push(field)
      field = ''
    } else if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (char !== '\r') {
      field += char
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.map((cells) => cells.map((cell) => cell.trim()))
}

// ---------------------------------------------------------------------------
// pdf
// ---------------------------------------------------------------------------

/**
 * 从 PDF 里抽文字。**只做「能读多少算多少」，抽不出来就明确失败。**
 *
 * 做法是暴力的：扫所有 `stream … endstream`，能解压的解压，然后在内容流里找
 * `(文字) Tj` 与 `[(文)(字)] TJ`。这条路绕开了 xref、对象流、加密 —— 也绕开了
 * 字体映射，所以 CID 编码的中文 PDF 抽出来会是空或乱码。
 *
 * 因此判据是**结果**而不是过程：抽出来的文本里中文字符占比太低、或几乎全是替换
 * 字符，就当作没抽出来，让操作员另存为 Excel。给一堆乱码比给一个明确的失败更糟。
 */
function parsePdf(bytes: Uint8Array): string[] {
  const latin = Buffer.from(bytes).toString('latin1')
  const chunks: string[] = []

  let cursor = 0
  while (cursor < latin.length) {
    const start = latin.indexOf('stream', cursor)
    if (start === -1) break
    const end = latin.indexOf('endstream', start)
    if (end === -1) break

    // `stream` 后面跟 CRLF 或 LF，正文从下一个字节开始。
    let dataStart = start + 6
    if (latin[dataStart] === '\r') dataStart += 1
    if (latin[dataStart] === '\n') dataStart += 1

    const raw = bytes.subarray(dataStart, end)
    cursor = end + 9

    let text: string | null = null
    for (const inflate of [inflateSync, inflateRawSync]) {
      try {
        text = Buffer.from(inflate(raw)).toString('latin1')
        break
      } catch {
        // 试下一个算法。
      }
    }
    // 没压缩的内容流是合法的（小文件常见），直接当明文。
    text ??= Buffer.from(raw).toString('latin1')
    if (!text.includes('Tj') && !text.includes('TJ')) continue
    chunks.push(text)
  }

  const lines: string[] = []
  for (const chunk of chunks) {
    // `(…)` 里的转义：\\ \( \) \n 等。
    const literal = /\((?:\\.|[^\\()])*\)/g
    let pending = ''
    let lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = literal.exec(chunk)) !== null) {
      const between = chunk.slice(lastIndex, match.index)
      lastIndex = match.index + match[0].length
      const content = match[0]
        .slice(1, -1)
        .replace(/\\([\\()])/g, '$1')
        .replace(/\\n/g, ' ')
      // `TJ` 里连续的字符串属于同一行，`Tj` 之后通常换行。
      if (/\bTJ\b/.test(between)) pending += content
      else {
        if (pending !== '' || content !== '') lines.push((pending + content).trim())
        pending = ''
      }
      if (/\bET\b|\bTd\b|\bTD\b|\bT\*/.test(between)) {
        if (pending !== '') {
          lines.push(pending.trim())
          pending = ''
        }
      }
    }
    if (pending !== '') lines.push(pending.trim())
  }

  return lines.filter((line) => line !== '')
}

/** 中文字符 + 拉丁字母的占比。低于阈值说明抽出来的不是可读文本。 */
function readableRatio(text: string): number {
  if (text === '') return 0
  let readable = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x20 && code <= 0x7e)) readable += 1
  }
  return readable / [...text].length
}

// ---------------------------------------------------------------------------
// 表头与列映射
// ---------------------------------------------------------------------------

type Field =
  | 'category'
  | 'name'
  | 'model'
  | 'spec'
  | 'unit'
  | 'priceText'
  | 'note'
  | 'pricingMode'
  | 'materials'
  | 'ledgerNo'

/**
 * 表头关键词。**顺序即优先级**：`规格型号` 同时含「规格」与「型号」，必须先判型号，
 * 否则型号列会被当成规格列，而两列都有值时界面上看不出错。
 */
const HEADER_RULES: readonly { field: Field; words: readonly string[] }[] = [
  { field: 'ledgerNo', words: ['条目号', '序号', '编号', '行号'] },
  { field: 'model', words: ['型号', '规格型号', '产品型号'] },
  { field: 'spec', words: ['规格', '尺寸', '宽度', '厚度'] },
  { field: 'pricingMode', words: ['计价方式', '计价', '计费方式', '计价单位'] },
  { field: 'materials', words: ['花色', '可选花色', '颜色'] },
  { field: 'unit', words: ['单位'] },
  { field: 'priceText', words: ['单价', '价格', '收费', '收费标准', '金额', '报价'] },
  { field: 'note', words: ['备注', '说明', '描述', '注释'] },
  { field: 'category', words: ['分类', '品类', '类别', '系列', '分组', '大类'] },
  // 「材质」放最后：销售台账里它是产品名（`E0级实木颗粒板（柜+门）标板`），
  // 而不是材料属性。放在 name 的候选里、优先级最低，避免抢走「产品名称」。
  { field: 'name', words: ['产品名称', '名称', '品名', '项目', '材质'] },
]

function matchField(header: string): Field | null {
  const text = header.replace(/\s+/g, '')
  if (text === '') return null
  for (const rule of HEADER_RULES) {
    if (rule.words.some((word) => text.includes(word))) return rule.field
  }
  return null
}

function looksLikeHeader(cells: readonly string[]): boolean {
  const hits = cells.filter((cell) => matchField(cell) !== null).length
  return hits >= 2
}

/** 合计行、表头重复行、说明行 —— 它们不该变成产品。 */
function isNoise(cells: readonly string[]): boolean {
  const first = (cells[0] ?? '').replace(/\s+/g, '')
  if (first === '') return false
  return /^(合计|小计|总计|备注[:：]|说明[:：]|注[:：])/.test(first)
}

const SOURCE_HINTS: readonly { source: QuoteSource; words: readonly string[] }[] = [
  { source: 'sale', words: ['销售', '查价系统', '柜体'] },
  { source: 'craft', words: ['工艺', '板式'] },
  { source: 'hardware', words: ['五金', '诺米', '百隆', '拉篮'] },
]

function guessSource(fileName: string): QuoteSource | null {
  for (const hint of SOURCE_HINTS) {
    if (hint.words.some((word) => fileName.includes(word))) return hint.source
  }
  return null
}

function emptyRow(): QuoteImportRow {
  return {
    category: '',
    name: '',
    model: '',
    spec: '',
    unit: '',
    priceText: '',
    note: '',
    pricingMode: '',
    materials: '',
    ledgerNo: '',
  }
}

const CLIP: Record<Field, number> = {
  category: QUOTE_LIMITS.CATEGORY_NAME_MAX,
  name: QUOTE_LIMITS.ITEM_NAME_MAX,
  model: 120,
  spec: 160,
  unit: 24,
  priceText: 200,
  note: 400,
  pricingMode: 40,
  materials: 300,
  ledgerNo: 12,
}

function assign(row: QuoteImportRow, field: Field, value: string): void {
  row[field] = value.replace(/\s+/g, ' ').trim().slice(0, CLIP[field])
}

/**
 * 二维表 → 产品行。
 *
 * ## 分类向下填充
 *
 * 台账里分类是合并单元格，xlsx 只在合并块的第一行写值。不填充的话，一个分类下
 * 只有第一条带分类，其余全部落到空分类里 —— 而空分类不会报错，只是搜不到。
 *
 * ## 没有表头时按位置猜
 *
 * PDF 抽出来的文本通常没有表头。这时按「第一列名称、最后一列价格、中间进规格」
 * 处理，并在警告里说明 —— 猜错是常态，所以必须让人看见这是猜的。
 */
export function mapMatrixToRows(
  matrix: readonly string[][],
  options: { hasHeader: boolean; columnMap: Map<number, Field> },
): { rows: ParsedRow[]; warnings: string[] } {
  const rows: ParsedRow[] = []
  const warnings: string[] = []
  const hasCategoryColumn = [...options.columnMap.values()].includes('category')
  const hasPriceColumn = [...options.columnMap.values()].includes('priceText')

  let lastCategory = ''
  let skippedNoise = 0
  let missingName = 0

  for (let index = 0; index < matrix.length; index += 1) {
    const cells = matrix[index]!
    const line = index + 1
    if (cells.every((cell) => (cell ?? '').trim() === '')) continue
    if (options.hasHeader && index === 0) continue
    if (isNoise(cells)) {
      skippedNoise += 1
      continue
    }
    if (options.hasHeader && looksLikeHeader(cells)) continue

    const row = emptyRow()
    for (const [column, field] of options.columnMap) {
      assign(row, field, cells[column] ?? '')
    }

    // 分类向下填充。空分类的行继承上一个分类 —— 台账里分类是合并单元格，只有
    // 合并块的第一行带值。
    if (row.category === '') row.category = lastCategory
    else lastCategory = row.category

    if (row.name === '') {
      missingName += 1
      continue
    }

    const rowWarnings: string[] = []
    if (hasPriceColumn && row.priceText === '') rowWarnings.push('没有识别到价格')
    if (hasCategoryColumn && row.category === '') rowWarnings.push('没有分类')

    rows.push({ ...row, sourceLine: line, warnings: rowWarnings })
    if (rows.length >= QUOTE_LIMITS.IMPORT_ROWS_MAX) {
      warnings.push(`超过 ${QUOTE_LIMITS.IMPORT_ROWS_MAX} 行的部分没有导入，请拆成多份`)
      break
    }
  }

  if (skippedNoise > 0) warnings.push(`跳过了 ${skippedNoise} 行合计 / 说明行`)
  if (missingName > 0) warnings.push(`跳过了 ${missingName} 行没有名称的行`)

  return { rows, warnings }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export function parseQuoteFile(fileName: string, bytes: Uint8Array): ParseResult {
  if (bytes.length === 0) {
    return { ok: false, reason: 'empty_file', message: '文件是空的' }
  }
  if (bytes.length > QUOTE_LIMITS.IMPORT_FILE_BYTES_MAX) {
    return {
      ok: false,
      reason: 'too_large',
      message: `文件超过 ${Math.round(QUOTE_LIMITS.IMPORT_FILE_BYTES_MAX / 1024 / 1024)}MB`,
    }
  }

  const format = detectFormat(fileName, bytes)
  if (format === null) {
    return {
      ok: false,
      reason: 'unsupported',
      message: '只认 Excel（.xlsx）、CSV 与 PDF。旧版 .xls 请另存为 .xlsx 再导入。',
    }
  }

  const fileWarnings: string[] = []
  let matrix: string[][]

  try {
    if (format === 'xlsx') {
      matrix = parseXlsx(bytes).matrix
    } else if (format === 'csv') {
      matrix = parseCsv(new TextDecoder('utf-8').decode(bytes))
    } else {
      const lines = parsePdf(bytes)
      const joined = lines.join('')
      if (lines.length === 0 || readableRatio(joined) < 0.35) {
        return {
          ok: false,
          reason: 'parse_failed',
          message:
            '这份 PDF 里抽不出可读文字（可能是扫描件，或字体编码无法还原）。请另存为 Excel 或 CSV 再导入。',
        }
      }
      // PDF 没有列的概念，按「2 个以上空白」切列 —— 排版对齐的表通常还能切开。
      matrix = lines.map((line) => line.split(/\s{2,}|\t/).map((cell) => cell.trim()))
      fileWarnings.push(
        'PDF 只能按位置猜列，分类 / 名称 / 规格可能串行。请在下方逐条核对后再导入。',
      )
    }
  } catch (error) {
    return {
      ok: false,
      reason: 'parse_failed',
      message: error instanceof Error ? error.message : '解析失败',
    }
  }

  if (matrix.length === 0) {
    return { ok: false, reason: 'no_rows', message: '文件里没有读到任何一行' }
  }

  const header = matrix[0] ?? []
  const hasHeader = looksLikeHeader(header)
  const columnMap = new Map<number, Field>()
  const detectedColumns: string[] = []

  if (hasHeader) {
    header.forEach((cell, index) => {
      const field = matchField(cell)
      if (field === null) return
      // 同一字段只认第一列。台账里「单价」后面常跟一列「单位价说明」，两列都含
      // 「价」字时，先到的那列才是真的单价。
      if ([...columnMap.values()].includes(field)) return
      columnMap.set(index, field)
      detectedColumns.push(`${cell} → ${field}`)
    })
  } else {
    const width = matrix.reduce((max, cells) => Math.max(max, cells.length), 0)
    fileWarnings.push('没有识别到表头，已按「首列名称、末列价格」猜测列位置，请逐条核对。')
    if (width >= 1) columnMap.set(0, 'name')
    if (width >= 2) columnMap.set(width - 1, 'priceText')
    for (let index = 1; index < width - 1; index += 1) columnMap.set(index, 'spec')
  }

  const mapped = mapMatrixToRows(matrix, { hasHeader, columnMap })
  if (mapped.rows.length === 0) {
    return {
      ok: false,
      reason: 'no_rows',
      message: hasHeader ? '表头认出来了，但下面没有数据行' : '没有识别到可导入的行',
    }
  }

  return {
    ok: true,
    value: {
      format,
      rows: mapped.rows,
      warnings: [...fileWarnings, ...mapped.warnings],
      detectedColumns,
      suggestedSource: guessSource(fileName),
    },
  }
}
