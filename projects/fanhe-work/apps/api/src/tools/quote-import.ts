/**
 * 台账导入：把 `data/quote/dataset.json` 幂等写进库。
 *
 * ## 为什么是「先跑 Python 再跑这条」
 *
 * 台账是 xlsx，图片锚点藏在 drawing XML 里，那套解析在本机已用 Python 跑通过
 * （见 `tools/quote-import/build_dataset.py` 文件头）。这里只做「读 JSON + 写库」。
 * 两段之间用数据文件解耦，任何一段出错都能单独重跑。
 *
 * ## 幂等靠业务键，不靠「清空重灌」
 *
 * 清空重灌会把三样东西一起毁掉：图片绑定（imageKey 指向的图行没了）、在线改过的
 * 价格（被打回台账值）、审计链（`quote_revisions.item_code` 指向的条目不存在了）。
 * 所以走 upsert：键由台账五列算出（`quote/keys.ts`），同一份台账导十次得到同一批
 * 行，只有 `updatedAt` 变新。
 *
 * ## 台账里消失的行转 archived，不删
 *
 * 客户拿着一张上个月的报价单来问「这条现在多少钱」，硬删只能回答「没有这条」，
 * 而 archived 能回答「下架了，当时是 X 元」。
 *
 * ## 人工覆盖优先
 *
 * 图片同步会跳过 `uploadedBy` 非空的活动图：那是有人在界面上手工传的，台账里没有
 * 它，导入不该把它顶掉。这条漏掉的后果是「每次导入，手工换的图都消失一次」，
 * 而且不报错。
 *
 * 用法（在 apps/api 下）：
 *   node_modules/.bin/tsx src/tools/quote-import.ts [dataset.json 路径] [--force]
 */
import fs from 'node:fs'
import path from 'node:path'

import { QUOTE_PRICE_KINDS } from '@fanhe/shared'

import { prisma } from '../db/prisma.js'
import { buildQuoteFamilyKey, buildQuoteItemCode } from '../quote/keys.js'

type DatasetItem = {
  rawKey: string
  occurrence: number
  source: string
  category: string
  name: string
  model: string
  spec: string
  unit: string
  unitRaw: string
  priceKind: string
  priceFen: number | null
  priceText: string
  note: string
  sheet: string | null
  row: number | null
}

type DatasetImage = {
  rawKey: string
  bindType: 'exact' | 'family'
  file: string
  thumb: string
  width: number
  height: number
  mime: string
  byteSize: number
  sourceRow: number | null
  familyParts?: { source: string; category: string; name: string }
}

type Dataset = {
  sourceNote: string
  items: DatasetItem[]
  images: DatasetImage[]
  counts: Record<string, number>
  fingerprint: string
}

const DEFAULT_RELATIVE = path.join('..', '..', 'data', 'quote', 'dataset.json')

/** 列宽上限。超了要截断 —— 让 PostgreSQL 直接报 22001 的话，整批导入会停在一半。 */
const COLUMN_MAX = {
  category: 80,
  name: 200,
  model: 120,
  spec: 160,
  unit: 24,
  unitRaw: 24,
  priceText: 200,
  note: 400,
  code: 64,
} as const

const KNOWN_PRICE_KINDS = new Set<string>(QUOTE_PRICE_KINDS)

function resolveInputPath(argv: readonly string[]): string {
  const explicit = argv[2]
  if (explicit !== undefined && !explicit.startsWith('-') && explicit.trim() !== '') {
    return path.resolve(explicit)
  }
  return path.resolve(process.cwd(), DEFAULT_RELATIVE)
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max)
}

/**
 * 形状检查。
 *
 * 只挡「根本不是一个数据集」这一类输入：缺数组、价格形态不在枚举里。真正的业务
 * 校验（价格范围、图片字节）在库的约束与接口层，这里重复一遍没有意义。
 *
 * 价格形态要在这里拦，是因为它一旦进库，界面就渲染不出来 —— 而 `priceKind` 是
 * 决定「显示 ¥668 还是 1.5 倍」的唯一依据，渲染不出来时页面上是一个空格子，
 * 看不出是数据错了还是样式错了。
 */
function parseDataset(raw: string, file: string): Dataset {
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${file} 不是一个 JSON 对象`)
  }
  const candidate = parsed as Partial<Dataset>
  if (!Array.isArray(candidate.items) || !Array.isArray(candidate.images)) {
    throw new Error(`${file} 缺少 items / images 数组`)
  }
  if (typeof candidate.fingerprint !== 'string' || candidate.fingerprint.length < 16) {
    throw new Error(`${file} 缺少内容指纹，重新跑一次 build_dataset.py`)
  }

  for (const item of candidate.items) {
    if (!KNOWN_PRICE_KINDS.has(item.priceKind)) {
      throw new Error(
        `${file} 里出现未知的价格形态 ${String(item.priceKind)}（条目 ${item.rawKey.slice(0, 40)}）`,
      )
    }
  }

  return candidate as Dataset
}

async function main(): Promise<void> {
  const file = resolveInputPath(process.argv)
  const force = process.argv.includes('--force')

  if (!fs.existsSync(file)) {
    console.error(`找不到数据集：${file}`)
    console.error('先跑 python tools/quote-import/build_dataset.py 生成它。')
    process.exitCode = 1
    return
  }

  const dataset = parseDataset(fs.readFileSync(file, 'utf8'), file)
  const baseDir = path.dirname(file)
  const version = dataset.fingerprint.slice(0, 32)

  // 键只在这里算一次。Python 侧不重复实现，理由见 build_dataset.py 文件头。
  const codeOf = new Map<string, string>()
  const codesByRawKey = new Map<string, string[]>()
  for (const item of dataset.items) {
    const code = buildQuoteItemCode({
      source: item.source,
      category: item.category,
      name: item.name,
      model: item.model,
      spec: item.spec,
      occurrence: item.occurrence,
    })
    if (code.length > COLUMN_MAX.code) {
      throw new Error(`业务键超长（${code.length}）：${item.rawKey.slice(0, 40)}`)
    }
    codeOf.set(`${item.rawKey}\u001f${item.occurrence}`, code)
    const list = codesByRawKey.get(item.rawKey) ?? []
    list.push(code)
    codesByRawKey.set(item.rawKey, list)
  }

  // 图的键：exact 用这一行的 code（同名多行时用首个），family 用族键。
  const imageTargets = new Map<string, { imageKey: string; image: DatasetImage }>()
  let bindingMisses = 0
  for (const image of dataset.images) {
    const candidates = codesByRawKey.get(image.rawKey)
    if (candidates === undefined) {
      bindingMisses += 1
      continue
    }
    const imageKey =
      image.bindType === 'family' && image.familyParts !== undefined
        ? buildQuoteFamilyKey(image.familyParts)
        : candidates[0]!
    imageTargets.set(imageKey, { imageKey, image })
  }

  const previous = await prisma.quoteDataset.findFirst({
    orderBy: { importedAt: 'desc' },
    select: { version: true },
  })
  const activeCount = await prisma.quoteItem.count({ where: { status: 'active' } })
  if (!force && previous?.version === version && activeCount === dataset.items.length) {
    console.log(`数据集没有变化（${version.slice(0, 12)}，${activeCount} 条），跳过。`)
    console.log('要强制重导，加 --force。')
    return
  }

  // ---- 条目 ----
  //
  // 分批提交而不是一个大事务：1225 条 upsert 远超 Prisma 交互式事务的默认 5 秒，
  // 而这里每一步都幂等 —— 中途失败重跑一次就补上了，比为了「原子」把超时调大更稳。
  let added = 0
  let changed = 0
  const existing = new Map(
    (
      await prisma.quoteItem.findMany({
        select: { code: true, priceKind: true, priceFen: true, priceText: true, status: true },
      })
    ).map((row) => [row.code, row]),
  )

  const CHUNK = 150
  for (let offset = 0; offset < dataset.items.length; offset += CHUNK) {
    const slice = dataset.items.slice(offset, offset + CHUNK)
    await prisma.$transaction(
      slice.map((item) => {
        const code = codeOf.get(`${item.rawKey}\u001f${item.occurrence}`)!
        const before = existing.get(code)
        if (before === undefined) added += 1
        else if (
          before.priceKind !== item.priceKind ||
          before.priceFen !== item.priceFen ||
          before.priceText !== item.priceText ||
          before.status !== 'active'
        ) {
          changed += 1
        }

        const data = {
          source: clip(item.source, 16),
          category: clip(item.category, COLUMN_MAX.category),
          name: clip(item.name, COLUMN_MAX.name),
          model: clip(item.model, COLUMN_MAX.model),
          spec: clip(item.spec, COLUMN_MAX.spec),
          unit: clip(item.unit, COLUMN_MAX.unit),
          unitRaw: clip(item.unitRaw, COLUMN_MAX.unitRaw),
          priceKind: item.priceKind,
          priceFen: item.priceFen,
          priceText: clip(item.priceText, COLUMN_MAX.priceText),
          note: clip(item.note, COLUMN_MAX.note),
          status: 'active',
          datasetVersion: version,
        }

        return prisma.quoteItem.upsert({
          where: { code },
          // `imageKey` 不在更新字段里：它由下面单独一步「只补空」维护，手工换的
          // 图不该被台账顶掉。
          create: { code, ...data },
          update: data,
        })
      }),
    )
  }

  const allCodes = [...codeOf.values()]
  const archived = await prisma.quoteItem.updateMany({
    where: { status: 'active', code: { notIn: allCodes } },
    data: { status: 'archived', datasetVersion: version },
  })

  // ---- 图片 ----
  const activeImages = await prisma.quoteItemImage.findMany({
    where: { isActive: true },
    select: {
      imageKey: true,
      byteSize: true,
      width: true,
      height: true,
      sourceRow: true,
      uploadedBy: true,
    },
  })
  const imageByKey = new Map(activeImages.map((row) => [row.imageKey, row]))

  let imagesWritten = 0
  let imagesSkipped = 0
  for (const { imageKey, image } of imageTargets.values()) {
    const current = imageByKey.get(imageKey)
    // 人工传的图优先。这条漏掉的后果是「每次导入，手工换的图都消失一次」。
    if (current !== undefined && current.uploadedBy !== null) {
      imagesSkipped += 1
      continue
    }
    if (
      current !== undefined &&
      current.byteSize === image.byteSize &&
      current.width === image.width &&
      current.height === image.height &&
      current.sourceRow === image.sourceRow
    ) {
      imagesSkipped += 1
      continue
    }

    const dataPath = path.join(baseDir, 'images', image.file)
    const thumbPath = path.join(baseDir, 'thumbs', image.thumb)
    if (!fs.existsSync(dataPath) || !fs.existsSync(thumbPath)) {
      console.warn(`  缺图文件：${image.file} / ${image.thumb}（跳过 ${imageKey}）`)
      continue
    }
    const data = new Uint8Array(fs.readFileSync(dataPath))
    const thumb = new Uint8Array(fs.readFileSync(thumbPath))

    await prisma.$transaction([
      prisma.quoteItemImage.updateMany({
        where: { imageKey, isActive: true },
        data: { isActive: false },
      }),
      prisma.quoteItemImage.create({
        data: {
          imageKey,
          data,
          thumb,
          mime: image.mime,
          width: image.width,
          height: image.height,
          thumbWidth: image.width >= 320 ? 320 : image.width,
          thumbHeight: Math.max(
            1,
            Math.round((image.height * Math.min(320, image.width)) / Math.max(1, image.width)),
          ),
          byteSize: data.length,
          bindType: image.bindType,
          sourceRow: image.sourceRow,
          uploadedBy: null,
        },
      }),
    ])
    imagesWritten += 1
  }

  // ---- 条目 → 图：只补空 ----
  //
  // 已经指向某张图的条目不动。exact 情形的键恒等于 code，family 情形的键在同族内
  // 不变 —— 也就是说「补空」之后不会再变，不需要每轮重设。
  for (const item of dataset.items) {
    const code = codeOf.get(`${item.rawKey}\u001f${item.occurrence}`)!
    const target =
      imageTargets.get(code) ??
      imageTargets.get(
        buildQuoteFamilyKey({
          source: item.source,
          category: item.category,
          name: item.name,
        }),
      )
    const imageKey = target?.imageKey ?? null
    if (imageKey === null) continue
    await prisma.quoteItem.updateMany({
      where: { code, imageKey: null },
      data: { imageKey },
    })
  }

  await prisma.quoteDataset.create({
    data: {
      version,
      itemCount: dataset.items.length,
      imageCount: imageTargets.size,
      addedCount: added,
      changedCount: changed,
      archivedCount: archived.count,
      sourceNote: clip(dataset.sourceNote ?? '', 300),
    },
  })

  console.log(`数据集 ${version.slice(0, 12)} 已写入`)
  console.log(
    `条目 ${dataset.items.length}：新增 ${added} / 变更 ${changed} / 归档 ${archived.count}`,
  )
  console.log(`图片 ${imageTargets.size}：写入 ${imagesWritten} / 跳过 ${imagesSkipped}`)
  if (bindingMisses > 0) {
    console.warn(`有 ${bindingMisses} 张图找不到对应的条目 —— 业务键规则可能被改过。`)
  }
  const total = await prisma.quoteItem.count({ where: { status: 'active' } })
  const withImage = await prisma.quoteItem.count({
    where: { status: 'active', imageKey: { not: null } },
  })
  console.log(`库里现在 active ${total} 条，其中 ${withImage} 条带图。`)
}

await main()
await prisma.$disconnect()
