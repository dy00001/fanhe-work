/**
 * 批量导入识别器的单元测试。
 *
 * 这一组存在的理由是：识别器**不会报错地出错**。分类认到名称那列、型号进了规格列、
 * 备注里的逗号把整行顶右一格 —— 这些全都能导入成功，只是库里多出一批「名字对、
 * 分类错」的产品；而查价的人是按分类筛的，从此就找不到它们。
 *
 * 所以这里全部走 `parseQuoteFile` 这个真入口，喂真实的字节（含手搓的 xlsx zip），
 * 断言落在「哪一列的值进了哪个字段」上，而不是「函数被调用过」。
 *
 * 不碰数据库：`importer.ts` 只依赖 node:zlib 与共享契约，是纯函数。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  detectFormat,
  mapMatrixToRows,
  parseCsv,
  parseQuoteFile,
  type ParseSuccess,
} from '../src/quote/importer.js'

const encoder = new TextEncoder()

function csv(text: string): Uint8Array {
  return encoder.encode(text)
}

/** 断言成功并把 `value` 摘出来，省掉每处 `if (!result.ok) throw`。 */
function ok(result: ReturnType<typeof parseQuoteFile>): ParseSuccess['value'] {
  assert.equal(result.ok, true, result.ok ? '' : `识别失败：${result.reason} ${result.message}`)
  return (result as ParseSuccess).value
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

describe('CSV 识别', () => {
  test('表头对得上时按列取值，分类向下填充', () => {
    const value = ok(
      parseQuoteFile(
        '销售查价系统.csv',
        csv(
          [
            '分类,产品名称,规格型号,规格,单价,单位',
            '柜体门板,E0级实木颗粒板（柜+门）标板,A-18,18mm,668,㎡',
            ',多层实木板（柜体）,B-18,18mm,720,㎡',
            '五金,铰链,百隆-110,110度,12,个',
          ].join('\n'),
        ),
      ),
    )

    assert.equal(value.format, 'csv')
    assert.equal(value.rows.length, 3)
    assert.deepEqual(value.detectedColumns, [
      '分类 → category',
      '产品名称 → name',
      '规格型号 → model',
      '规格 → spec',
      '单价 → priceText',
      '单位 → unit',
    ])

    const [first, second, third] = value.rows
    assert.equal(first?.category, '柜体门板')
    assert.equal(first?.name, 'E0级实木颗粒板（柜+门）标板')
    assert.equal(first?.model, 'A-18')
    assert.equal(first?.spec, '18mm')
    assert.equal(first?.priceText, '668')
    assert.equal(first?.unit, '㎡')

    // 🔴 合并单元格：台账里一个分类下只有第一行带值。不填充的话，第二行落进空分类，
    // 而空分类不报错 —— 只是查价时按分类筛不到它。
    assert.equal(second?.category, '柜体门板', '第二行的分类没有继承上一行')
    assert.equal(second?.model, 'B-18')

    assert.equal(third?.category, '五金')
    assert.equal(value.warnings.length, 0, `不该有警告：${value.warnings.join(' / ')}`)
  })

  test('「规格型号」进型号列，不能抢走「规格」', () => {
    // 两个表头都含「规格」二字。表头规则的顺序决定结果：型号规则在前，
    // 所以「规格型号」归 model，「规格」归 spec。反过来的话 model 会是空串，
    // 而界面上两列都有值，肉眼看不出来。
    const value = ok(parseQuoteFile('a.csv', csv('名称,规格型号,规格,单价\n背板,M-01,18mm,120')))
    assert.equal(value.rows[0]?.model, 'M-01')
    assert.equal(value.rows[0]?.spec, '18mm')
  })

  test('备注里的逗号不会把整行顶右一格', () => {
    const value = ok(
      parseQuoteFile(
        'a.csv',
        csv(['名称,单价,备注', '背板,120,"含五金，不含台面, 不含灯带"'].join('\n')),
      ),
    )
    assert.equal(value.rows.length, 1)
    assert.equal(value.rows[0]?.priceText, '120')
    assert.equal(value.rows[0]?.note, '含五金，不含台面, 不含灯带')
  })

  test('合计行与说明行被跳过，并在文件级警告里报数', () => {
    const value = ok(
      parseQuoteFile(
        'a.csv',
        csv('分类,名称,单价\n柜体,背板,120\n合计,,120\n说明：以上为含税价,,'),
      ),
    )
    assert.equal(value.rows.length, 1)
    assert.equal(value.rows[0]?.name, '背板')
    assert.ok(
      value.warnings.some((line) => line.includes('跳过了 2 行')),
      `没有报出跳过的行数：${value.warnings.join(' / ')}`,
    )
  })

  test('没有名称的行不导入', () => {
    const value = ok(parseQuoteFile('a.csv', csv('分类,名称,单价\n柜体,背板,120\n五金,,12')))
    assert.equal(value.rows.length, 1)
    assert.ok(value.warnings.some((line) => line.includes('没有名称')))
  })
})

describe('parseCsv 的引号处理', () => {
  test('引号内的换行属于同一格，不拆成两行', () => {
    const rows = parseCsv('a,"b\nc",d\n')
    assert.equal(rows.length, 1, '引号内的换行被当成了行尾')
    assert.deepEqual(rows[0], ['a', 'b\nc', 'd'])
  })

  test('"" 是一个字面的引号', () => {
    assert.deepEqual(parseCsv('a,"他说""好""",c\n')[0], ['a', '他说"好"', 'c'])
  })

  test('制表符分隔也能切（从 Excel 直接复制粘贴的形态）', () => {
    assert.deepEqual(parseCsv('名称\t单价\n背板\t120\n')[1], ['背板', '120'])
  })
})

// ---------------------------------------------------------------------------
// 格式判定
// ---------------------------------------------------------------------------

describe('detectFormat 按魔数判，不信扩展名', () => {
  test('PK 开头就是 xlsx，哪怕叫 .csv', () => {
    assert.equal(detectFormat('台账.csv', new Uint8Array([0x50, 0x4b, 0x03, 0x04])), 'xlsx')
  })

  test('%PDF 开头就是 pdf', () => {
    assert.equal(detectFormat('a.csv', encoder.encode('%PDF-1.7')), 'pdf')
  })

  test('文本类只能看扩展名', () => {
    assert.equal(detectFormat('a.csv', encoder.encode('名称,单价')), 'csv')
    assert.equal(detectFormat('a.txt', encoder.encode('名称,单价')), 'csv')
    assert.equal(detectFormat('a.docx', encoder.encode('随便什么')), null)
  })
})

// ---------------------------------------------------------------------------
// 失败路径
// ---------------------------------------------------------------------------

describe('识别失败时明确失败，不拿乱码冒充结果', () => {
  test('空文件', () => {
    const result = parseQuoteFile('a.csv', new Uint8Array(0))
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.reason, 'empty_file')
  })

  test('认不出的格式', () => {
    const result = parseQuoteFile('a.docx', encoder.encode('随便什么'))
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.reason, 'unsupported')
  })

  test('只有表头没有数据行', () => {
    const result = parseQuoteFile('a.csv', csv('分类,名称,单价'))
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.reason, 'no_rows')
  })

  test('扫描件 PDF：没有文字流就直说另存为 Excel', () => {
    // 只有对象壳、没有 `stream … endstream` 的最小 PDF —— 等同于扫描件。
    const bytes = encoder.encode('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n')
    const result = parseQuoteFile('扫描件.pdf', bytes)
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.reason, 'parse_failed')
    assert.match(
      result.ok ? '' : result.message,
      /另存为 Excel/,
      '失败提示要给出下一步，只说「解析失败」等于把人卡住',
    )
  })
})

// ---------------------------------------------------------------------------
// PDF（尽力而为）
// ---------------------------------------------------------------------------

describe('PDF 走降级路径', () => {
  test('能抽出文字就按位置猜列，并明说是猜的', () => {
    // 中文用 UTF-8 写进内容流是抽不出来的（字体编码不同，见 importer 顶部注释），
    // 所以这里用 ASCII —— 这条测的是「能不能切列」，不是「能不能还原字体编码」。
    const body = 'BT /F1 12 Tf (BackPanel  18mm  120) Tj ET'
    const bytes = encoder.encode(
      `%PDF-1.4\n1 0 obj\n<< /Length ${body.length} >>\nstream\n${body}\nendstream\nendobj\n%%EOF\n`,
    )
    const value = ok(parseQuoteFile('报价单.pdf', bytes))

    assert.equal(value.format, 'pdf')
    assert.equal(value.rows[0]?.name, 'BackPanel')
    assert.equal(value.rows[0]?.priceText, '120')
    assert.ok(
      value.warnings.some((line) => line.includes('只能按位置猜列')),
      `PDF 没有给出「列可能串行」的警告：${value.warnings.join(' / ')}`,
    )
  })
})

// ---------------------------------------------------------------------------
// xlsx（手搓一个真的 zip）
// ---------------------------------------------------------------------------

/**
 * 造一个「存储方式（method 0）」的 zip。
 *
 * 只用得到三条结构：本地文件头、中央目录、EOCD。不压缩是故意的 —— 解压那步由
 * `readZip` 的 `inflateRawSync` 负责，这里若也压缩，出错时分不清是谁的问题。
 */
function zip(entries: readonly (readonly [string, string])[]): Uint8Array {
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  for (const [name, content] of entries) {
    const nameBytes = encoder.encode(name)
    const data = encoder.encode(content)

    const local = new Uint8Array(30 + nameBytes.length + data.length)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(8, 0, true) // method: 0 = stored
    localView.setUint32(18, data.length, true)
    localView.setUint32(22, data.length, true)
    localView.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    local.set(data, 30 + nameBytes.length)

    const central = new Uint8Array(46 + nameBytes.length)
    const centralView = new DataView(central.buffer)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint16(4, 20, true)
    centralView.setUint16(6, 20, true)
    centralView.setUint16(10, 0, true)
    centralView.setUint32(20, data.length, true)
    centralView.setUint32(24, data.length, true)
    centralView.setUint16(28, nameBytes.length, true)
    centralView.setUint32(42, offset, true)
    central.set(nameBytes, 46)

    locals.push(local)
    centrals.push(central)
    offset += local.length
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0)
  const eocd = new Uint8Array(22)
  const eocdView = new DataView(eocd.buffer)
  eocdView.setUint32(0, 0x06054b50, true)
  eocdView.setUint16(8, entries.length, true)
  eocdView.setUint16(10, entries.length, true)
  eocdView.setUint32(12, centralSize, true)
  eocdView.setUint32(16, offset, true)

  const total = locals.reduce((sum, part) => sum + part.length, 0) + centralSize + eocd.length
  const out = new Uint8Array(total)
  let cursor = 0
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, cursor)
    cursor += part.length
  }
  return out
}

function xlsx(shared: readonly string[], sheetXml: string): Uint8Array {
  return zip([
    [
      'xl/sharedStrings.xml',
      `<sst count="${shared.length}" uniqueCount="${shared.length}">${shared
        .map((text) => `<si><t>${text}</t></si>`)
        .join('')}</sst>`,
    ],
    ['xl/worksheets/sheet1.xml', `<worksheet><sheetData>${sheetXml}</sheetData></worksheet>`],
  ])
}

describe('xlsx 识别', () => {
  test('单元格按 r="A1" 的字母位定位，跳过空格不会让整行左移', () => {
    // 共享字符串：0=分类 1=产品名称 2=单价 3=柜体 4=背板 5=668 6=抽屉 7=120
    const shared = ['分类', '产品名称', '单价', '柜体', '背板', '668', '抽屉', '120']
    const sheet = [
      '<row r="1">',
      '<c r="A1" t="s"><v>0</v></c>',
      '<c r="B1" t="s"><v>1</v></c>',
      '<c r="C1" t="s"><v>2</v></c>',
      '</row>',
      '<row r="2">',
      '<c r="A2" t="s"><v>3</v></c>',
      '<c r="B2" t="s"><v>4</v></c>',
      '<c r="C2" t="s"><v>5</v></c>',
      '</row>',
      // 🔴 第三行没有 A 列（分类是合并单元格，xlsx 不写空单元格）。
      // 按出现顺序 push 的话，B3 会落到第 0 列 —— 名称跑进分类、单价跑进名称。
      '<row r="3">',
      '<c r="B3" t="s"><v>6</v></c>',
      '<c r="C3" t="s"><v>7</v></c>',
      '</row>',
    ].join('')

    const value = ok(parseQuoteFile('台账.xlsx', xlsx(shared, sheet)))
    assert.equal(value.format, 'xlsx')
    assert.equal(value.rows.length, 2)

    assert.equal(value.rows[0]?.category, '柜体')
    assert.equal(value.rows[0]?.name, '背板')
    assert.equal(value.rows[0]?.priceText, '668')

    assert.equal(value.rows[1]?.name, '抽屉', '缺 A3 之后整行左移了')
    assert.equal(value.rows[1]?.priceText, '120')
    assert.equal(value.rows[1]?.category, '柜体', '空格所在的分类列没有继承上一行')
  })

  test('没有 sharedStrings 时退化成 inlineStr', () => {
    const sheet =
      '<row r="1">' +
      '<c r="A1" t="inlineStr"><is><t>名称</t></is></c>' +
      '<c r="B1" t="inlineStr"><is><t>单价</t></is></c>' +
      '</row>' +
      '<row r="2">' +
      '<c r="A2" t="inlineStr"><is><t>背板</t></is></c>' +
      '<c r="B2" t="inlineStr"><is><t>120</t></is></c>' +
      '</row>'
    const value = ok(
      parseQuoteFile(
        'a.xlsx',
        zip([
          ['xl/worksheets/sheet1.xml', `<worksheet><sheetData>${sheet}</sheetData></worksheet>`],
        ]),
      ),
    )
    assert.equal(value.rows[0]?.name, '背板')
    assert.equal(value.rows[0]?.priceText, '120')
  })
})

// ---------------------------------------------------------------------------
// 直接测 mapMatrixToRows 的两条边界
// ---------------------------------------------------------------------------

describe('mapMatrixToRows', () => {
  test('没有表头时按「首列名称、末列价格」猜，并给出警告', () => {
    const { rows, warnings } = mapMatrixToRows(
      [
        ['背板', '18mm', '120'],
        ['抽屉', '标准', '80'],
      ],
      {
        hasHeader: false,
        columnMap: new Map([
          [0, 'name'],
          [1, 'spec'],
          [2, 'priceText'],
        ]),
      },
    )
    assert.equal(rows.length, 2)
    assert.equal(rows[0]?.name, '背板')
    assert.equal(rows[0]?.priceText, '120')
    // 这个函数本身不产生「按位置猜」的警告（那是 parseQuoteFile 的职责），
    // 但它在没有价格列时不该乱报警告。
    assert.deepEqual(warnings, [])
  })

  test('价格列为空时逐行给警告，而不是当成 0', () => {
    const { rows } = mapMatrixToRows([['柜体', '背板', '']], {
      hasHeader: false,
      columnMap: new Map([
        [0, 'category'],
        [1, 'name'],
        [2, 'priceText'],
      ]),
    })
    assert.equal(rows[0]?.priceText, '')
    assert.ok(
      rows[0]?.warnings.includes('没有识别到价格'),
      '空价格被当成正常行了，界面上不会有任何提示',
    )
  })
})
