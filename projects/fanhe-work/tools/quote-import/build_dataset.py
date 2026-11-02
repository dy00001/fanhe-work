# -*- coding: utf-8 -*-
"""把三份台账抽成 `data/quote/dataset.json` + 图片目录，供 `pnpm db:quote-import` 入库。

## 为什么这一段是 Python，而入库是 Node

台账是 xlsx：共享字符串、合并单元格、以及**图片锚点藏在 drawing XML 里**。这套
解析在本机已经用 Python 跑通过（Pillow 能解 EMF/WMF，那是 WPS 把位图包进图元文件
的产物，浏览器不认）。Node 侧要干的是「读 JSON + 幂等 upsert」，那件事用 Prisma
最顺手。

两者之间的边界是**数据文件**，不是进程调用：先跑这个脚本，再跑导入器。这样任何
一步出错都能单独重跑，也不会出现「Node 里再写一遍 xlsx 解析、两边算出的键不一致」。

## 为什么 dataset.json 里不存业务键

业务键（`sale-<16 位十六进制>`）由 Node 的 `buildQuoteItemCode` 计算，**只保留一份
实现**。这个脚本输出原始五元组 + 一个 `rawKey`（用 U+001F 拼起来，仅用于把
「图」和「条目」对上），Node 侧再按同一套规则折叠空白、算哈希。

如果这里也算一遍 code，两处实现迟早会漂移 —— 而漂移的表现是「图全绑不上」或
「条目每次导入都新增一遍」，两种都不报错，只是数据悄悄变错。

## 图片只导「对得上型号」的那些

台账内嵌 150 张图，其中约 130 张能锚定到具体行；其余是表头系列大图、同一型号的
第二张视图（正视图之外的尺寸图）。按方案的原则：**图错比没图更糟**，所以只导
主图，附加视图与封面留空。脚本结束时会把这两个数字打出来，免得下一次误以为
「图丢了」。
"""

import argparse
import hashlib
import io
import json
import os
import posixpath
import re
import sys
import unicodedata
import xml.etree.ElementTree as ET
import zipfile
from collections import Counter, defaultdict

from PIL import Image, ImageOps

NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
RNS = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
ANS = '{http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing}'
DRAW = '{http://schemas.openxmlformats.org/drawingml/2006/main}'

# 与 Node 侧 `quote/keys.ts` 的分隔符一致。它在 xlsx 里不可能出现（控制字符），
# 因此拿它拼 rawKey 不会有分隔符歧义。
SEP = '\u001f'

SOURCES = {
    'sale': '销售查价系统改1.xlsx',
    'craft': '板式产品工艺收费2026年05月.xlsx',
    'hardware': '诺米拉篮价格表.xlsx',
}


# ---------------------------------------------------------------------------
# xlsx 解析
# ---------------------------------------------------------------------------


def col_idx(ref):
    match = re.match(r'([A-Z]+)', ref or '')
    if not match:
        return 0
    n = 0
    for ch in match.group(1):
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def _cell_text(cell, strings):
    kind = cell.get('t')
    value = cell.find(NS + 'v')
    inline = cell.find(NS + 'is')
    if kind == 's' and value is not None:
        index = int(value.text)
        return strings[index] if index < len(strings) else ''
    if kind == 'inlineStr' and inline is not None:
        return ''.join(t.text or '' for t in inline.iter(NS + 't'))
    if value is not None:
        return value.text or ''
    return ''


def open_book(path):
    """返回 (zip, sharedStrings, [(sheetName, sheetPath)])。"""
    book = zipfile.ZipFile(path)
    strings = []
    if 'xl/sharedStrings.xml' in book.namelist():
        root = ET.fromstring(book.read('xl/sharedStrings.xml'))
        for si in root.findall(NS + 'si'):
            strings.append(''.join(t.text or '' for t in si.iter(NS + 't')))

    workbook = ET.fromstring(book.read('xl/workbook.xml'))
    rels = ET.fromstring(book.read('xl/_rels/workbook.xml.rels'))
    rid_to_target = {r.get('Id'): r.get('Target') for r in rels}

    sheets = []
    for sheet in workbook.find(NS + 'sheets'):
        target = rid_to_target.get(sheet.get(RNS + 'id'), '')
        if not target:
            continue
        if not target.startswith('xl/'):
            target = 'xl/' + target.lstrip('/')
        sheets.append((sheet.get('name'), target))
    return book, strings, sheets


def read_sheet(book, strings, target):
    """返回 (rows, rowNumbers)。行号是图片绑定的唯一可靠依据。

    表格里同名同型号很多，靠名称匹配必然串图；靠行号则与图片锚点天然同源。
    """
    root = ET.fromstring(book.read(target))
    data = root.find(NS + 'sheetData')
    rows, numbers = [], []
    if data is None:
        return rows, numbers
    for row in data.findall(NS + 'row'):
        values = {}
        for cell in row.findall(NS + 'c'):
            # 全角空格先换成半角：WPS 的表头里混着 U+3000，不换会让「单价」匹配不到。
            text = _cell_text(cell, strings).replace('\u3000', ' ').strip()
            if text:
                values[col_idx(cell.get('r'))] = text
        if values:
            width = max(values) + 1
            rows.append([values.get(i, '') for i in range(width)])
            numbers.append(int(row.get('r')))
    return rows, numbers


# ---------------------------------------------------------------------------
# 三源归一
# ---------------------------------------------------------------------------


def norm_part(value):
    """与 Node 的 normalizePart 逐字一致：折叠连续空白、去首尾空白。

    两处不一致的后果不是报错，而是「图绑不上」，所以这条规则必须一模一样。
    """
    return re.sub(r'\s+', ' ', value or '').strip()


def raw_key(item):
    return SEP.join(norm_part(item[k]) for k in ('source', 'category', 'name', 'model', 'spec'))


PRICE_KIND_MAP = {
    'number': 'amount',
    'perUnit': 'per_meter',
    'multiplier': 'multiplier',
    'text': 'rule',
    'none': 'empty',
}

UNIT_MAP = {
    '平方': '㎡',
    '平方米': '㎡',
    '平米': '㎡',
    '米': '米',
    '个': '个',
    '套': '套',
    '张': '张',
    '组': '组',
}


def to_fen(text):
    """从文本里取第一个数折成分。取不到返回 None。

    取不到就不能当 0 —— 「1.5 倍」与「待补价」都不是零元，显示成 ¥0 会让人按
    免费报价。
    """
    match = re.search(r'(\d+(?:\.\d+)?)', (text or '').replace(',', '').replace('，', ''))
    if not match:
        return None
    return int(round(float(match.group(1)) * 100))


def price_fields(raw_price, legacy_kind):
    """原文 → (kind, fen, text)。

    判定顺序与 `packages/shared/src/quote.ts` 的 `parsePriceInput` 保持一致：
    倍率与「按米」必须先于纯数字，否则「1.5 倍」里的 1.5 会被读成金额。
    """
    text = (raw_price or '').strip()
    if text == '':
        return 'empty', None, ''

    kind = PRICE_KIND_MAP.get(legacy_kind, 'rule')
    if kind == 'amount':
        return 'amount', to_fen(text), text
    if kind == 'per_meter':
        fen = to_fen(text)
        return ('per_meter', fen, text) if fen is not None else ('rule', None, text)
    if kind == 'multiplier':
        return 'multiplier', None, text
    if kind == 'empty':
        return 'empty', None, text
    return 'rule', None, text


def extract_sale(path, items):
    book, strings, sheets = open_book(path)
    if not sheets:
        return
    rows, _ = read_sheet(book, strings, sheets[0][1])
    category = ''
    for row in rows[1:]:
        row = row + [''] * 8
        if row[0]:
            category = row[0]
        name, unit, price, mode, remark = row[1], row[2], row[3], row[4], row[5]
        # **空价不跳过。** 4 条房门工艺整段空价，跳过它们会让「这类项目怎么报价」
        # 变成一个查不到的问题；留着并标成「待补价」才对。
        if not name:
            continue
        items.append(
            {
                'source': 'sale',
                'category': category,
                'name': name,
                'model': '',
                'spec': '',
                'unit': UNIT_MAP.get(unit.strip(), unit.strip()),
                'unitRaw': unit.strip(),
                'rawPrice': price,
                'legacyKind': legacy_price_kind(price),
                'note': ('计价：' + mode.strip() + '｜' if mode.strip() else '')
                + (remark.strip() if remark.strip() else ''),
                'sheet': None,
                'row': None,
            }
        )


def extract_craft(path, items):
    book, strings, sheets = open_book(path)
    if not sheets:
        return
    rows, _ = read_sheet(book, strings, sheets[0][1])
    category = ''
    for row in rows[2:]:
        row = row + [''] * 6
        if row[0]:
            category = row[0]
        project, unit, fee, note = row[1], row[2], row[3], row[4]
        if not project and not fee:
            continue
        items.append(
            {
                'source': 'craft',
                'category': category,
                'name': project,
                'model': '',
                'spec': '',
                'unit': UNIT_MAP.get(unit.strip(), unit.strip()),
                'unitRaw': unit.strip(),
                'rawPrice': fee,
                'legacyKind': legacy_price_kind(fee),
                'note': note.strip(),
                'sheet': None,
                'row': None,
            }
        )


def extract_hardware(path, items):
    book, strings, sheets = open_book(path)
    for sheet_name, target in sheets:
        rows, numbers = read_sheet(book, strings, target)
        if not rows:
            continue

        header_index, cols = None, {}
        for i, row in enumerate(rows[:6]):
            nxt = rows[i + 1] if i + 1 < len(rows) else []
            # 表头判据放宽到「本行有名称 + 本行或下一行有单价」：极克那张表的上行
            # 被日期序列（44835）占了单价列，只看本行会整张表判成无表头。
            if any('名称' in c for c in row) and (
                any('单价' in c for c in row) or any('单价' in c for c in nxt)
            ):
                header_index = i
                merged = {}
                # 表头可能跨两行，先按上行建，再用下行补齐；含「单价」的格子一律以它为准。
                for candidate in rows[i : i + 2]:
                    for j, text in enumerate(candidate):
                        if not text:
                            continue
                        if '单价' in text:
                            merged[j] = text
                        else:
                            merged.setdefault(j, text)
                for j, text in sorted(merged.items()):
                    if '图片' in text:
                        continue
                    if '名称' in text and 'name' not in cols:
                        cols['name'] = j
                    elif '型号' in text or '品号' in text:
                        cols.setdefault('model', j)
                        cols.setdefault('model2', j)
                    elif '规格' in text:
                        cols['spec'] = j
                    elif '单位' in text:
                        cols['unit'] = j
                    elif '单价' in text:
                        cols['price'] = j
                    elif '备注' in text or '说明' in text:
                        cols.setdefault('note', j)
                    elif '适用' in text:
                        cols.setdefault('fit', j)
                    elif '主架' in text:
                        cols.setdefault('model', j)
                    elif '篮体' in text:
                        cols.setdefault('model2', j)
                break

        if header_index is None or 'price' not in cols:
            print('  [跳过] %s：找不到表头（名称 + 单价）' % sheet_name)
            continue

        name = ''
        for k in range(header_index + 1, len(rows)):
            row = rows[k] + [''] * 12

            def get(key):
                idx = cols.get(key)
                return row[idx] if idx is not None and idx < len(row) else ''

            if get('name') and len(get('name')) > 1:
                name = get('name')
            price = get('price')
            # 单价必须以数字开头：表尾的「备注：…」与续行说明都在这一列里。
            if not price or not re.match(r'^\d', price):
                continue
            # 航母台那张整列产品名留空（靠 sheet 名承载），回落表名，否则整张表被丢掉。
            if not name:
                name = sheet_name

            model = get('model')
            model2 = get('model2')
            if model2 and model2 != model:
                model = (model + ' + ' + model2) if model else model2
            fit = get('fit')

            items.append(
                {
                    'source': 'hardware',
                    'category': sheet_name,
                    'name': name,
                    'model': model,
                    'spec': get('spec'),
                    'unit': UNIT_MAP.get(get('unit').strip(), get('unit').strip()),
                    'unitRaw': get('unit').strip(),
                    'rawPrice': price,
                    'legacyKind': legacy_price_kind(price),
                    'note': ((fit + '｜') if fit else '') + get('note'),
                    'sheet': sheet_name,
                    'row': numbers[k],
                }
            )


def legacy_price_kind(price):
    """旧版判型，保留原判定以免改口径。值域映射在 PRICE_KIND_MAP。"""
    price = (price or '').strip()
    if re.fullmatch(r'\d+(\.\d+)?', price):
        return 'number'
    if '倍' in price:
        return 'multiplier'
    if re.fullmatch(r'\d+(\.\d+)?\s*/\s*\S+', price) or re.fullmatch(
        r'\d+(\.\d+)?\s*元?\s*/\s*\S+.*', price
    ):
        return 'perUnit'
    if re.search(r'\d', price):
        return 'text'
    return 'none'


# ---------------------------------------------------------------------------
# 图片：锚点 → 绑定
# ---------------------------------------------------------------------------


def _rels(book, path):
    result = {}
    try:
        root = ET.fromstring(book.read(path))
    except KeyError:
        return result
    for row in root:
        result[row.get('Id')] = row.get('Target')
    return result


def parse_anchors(book, strings, sheet_name, sheet_path):
    """解析一张表里的图片锚点：行号 + 列号 + 媒体文件名。"""
    root = ET.fromstring(book.read(sheet_path))

    rows = {}
    for row in root.iter(NS + 'row'):
        cells = {}
        for cell in row.findall(NS + 'c'):
            cells[col_idx(re.sub(r'\d+', '', cell.get('r') or ''))] = _cell_text(cell, strings)
        rows[int(row.get('r'))] = cells

    drawing_rid = None
    for drawing in root.iter(NS + 'drawing'):
        drawing_rid = drawing.get(RNS + 'id')
    if not drawing_rid:
        return []

    sheet_rels = _rels(book, sheet_path.replace('worksheets/', 'worksheets/_rels/') + '.rels')
    target = sheet_rels.get(drawing_rid)
    if not target:
        return []
    drawing_path = posixpath.normpath(
        posixpath.join(posixpath.dirname(sheet_path), target)
    ) if not target.startswith('/') else target.lstrip('/')

    media_rels = _rels(book, drawing_path.replace('drawings/', 'drawings/_rels/') + '.rels')
    drawing = ET.fromstring(book.read(drawing_path))

    anchors = []
    for anchor in list(drawing):
        frm = anchor.find(ANS + 'from')
        if frm is None:
            continue
        blip = anchor.find('.//' + DRAW + 'blip')
        if blip is None:
            continue
        media = media_rels.get(blip.get(RNS + 'embed'), '')
        if not media:
            continue
        anchors.append(
            {
                'sheet': sheet_name,
                'row': int(frm.find(ANS + 'row').text) + 1,
                'col': int(frm.find(ANS + 'col').text),
                'media': media.replace('media/', ''),
            }
        )
    return anchors


def name_key(name):
    """判断「是否同一产品」用的归一：全半角、括号、空白全部拉平。

    只影响 family 继承的判断，不进业务键 —— 进业务键会让「同一行」因为一个全角
    括号变成两条。
    """
    text = unicodedata.normalize('NFKC', name or '')
    text = text.replace('(', '（').replace(')', '）')
    return re.sub(r'\s+', '', text).lower()


def bind_images(anchors, items):
    """exact（本行锚点图）/ family（紧邻同名块的首行图）。

    只继承「紧邻同名块」：同名块之前若已出现过别的产品，说明不是同族，宁可留空
    也不借别家的图。图错比没图更糟 —— 没图客户会问，错图客户会拿着报价单来投诉。
    """
    hardware = [it for it in items if it['source'] == 'hardware']
    by_row = defaultdict(list)
    for anchor in anchors:
        by_row[(anchor['sheet'], anchor['row'])].append(anchor)

    bindings = []
    stats = Counter()

    for sheet in dict.fromkeys(it['sheet'] for it in hardware):
        rows = sorted([it for it in hardware if it['sheet'] == sheet], key=lambda it: it['row'])
        last = None  # (media, nameKey, row, item)
        for item in rows:
            found = by_row.get((sheet, item['row']), [])
            if found:
                found = sorted(found, key=lambda a: a['col'])
                primary = found[0]['media']
                bindings.append(
                    {
                        'rawKey': raw_key(item),
                        'bindType': 'exact',
                        'file': primary,
                        'sourceRow': item['row'],
                    }
                )
                stats['exact'] += 1
                if len(found) > 1:
                    stats['extras'] += len(found) - 1
                last = (primary, name_key(item['name']), item['row'], item)
                continue

            if last is not None and last[1] == name_key(item['name']):
                bindings.append(
                    {
                        'rawKey': raw_key(item),
                        'bindType': 'family',
                        'file': last[0],
                        'sourceRow': last[2],
                        'familyParts': {
                            'source': last[3]['source'],
                            'category': last[3]['category'],
                            'name': last[3]['name'],
                        },
                    }
                )
                stats['family'] += 1
            else:
                last = None

    return bindings, stats


def export_images(book, bindings, out_dir, thumbs_dir):
    """把绑上用到的图导出：原图字节直通，另存一张 320px 缩略图。

    **原图不重编码。** 早先的版本是 `thumbnail(1100) + JPEG q84`，那是一次有损
    二次编码 —— 灯箱点开看到的是「缩过的缩略图再放大」，用户报的「模糊」正是它。
    EMF/WMF 例外：浏览器不认图元文件，按原生尺寸解出来无损存 PNG。
    """
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(thumbs_dir, exist_ok=True)

    files = sorted({b['file'] for b in bindings})
    meta, failed = {}, []
    passthrough = rerendered = 0

    for media in files:
        # WPS 写的 drawing rels 是 `../imageNN.jpeg` 这类不可靠相对路径，直接按
        # basename 到 xl/media/ 取 —— 这是唯一稳定的定位方式。
        source = 'xl/media/' + os.path.basename(media)
        key = os.path.splitext(os.path.basename(media))[0]
        ext = os.path.splitext(source)[1].lower()
        try:
            raw = book.read(source)
            if ext in ('.jpg', '.jpeg', '.png'):
                stored_ext = 'jpg' if ext in ('.jpg', '.jpeg') else 'png'
                with open(os.path.join(out_dir, key + '.' + stored_ext), 'wb') as fh:
                    fh.write(raw)
                image = Image.open(io.BytesIO(raw))
                image.load()
                width, height = image.size
                base = flatten(image)
                passthrough += 1
            else:
                image = ImageOps.exif_transpose(Image.open(io.BytesIO(raw)))
                image.load()
                width, height = image.size
                base = flatten(image)
                stored_ext = 'png'
                base.save(os.path.join(out_dir, key + '.png'), 'PNG', optimize=True)
                rerendered += 1

            thumb = base.copy()
            thumb.thumbnail((320, 320), Image.LANCZOS)
            thumb.save(os.path.join(thumbs_dir, key + '.jpg'), 'JPEG', quality=82, optimize=True)

            meta[key] = {
                'file': key + '.' + stored_ext,
                'thumb': key + '.jpg',
                'width': width,
                'height': height,
                'mime': 'image/jpeg' if stored_ext == 'jpg' else 'image/png',
                'byteSize': os.path.getsize(os.path.join(out_dir, key + '.' + stored_ext)),
            }
        except Exception as error:  # noqa: BLE001 - 单张坏图不该让整批失败
            failed.append((media, type(error).__name__, str(error)[:80]))

    return meta, {'passthrough': passthrough, 'rerendered': rerendered, 'failed': failed}


def flatten(image):
    """透明底铺白。商品图多是抠底 PNG，深色面板上会糊成一团黑。"""
    if image.mode in ('RGBA', 'LA', 'P'):
        image = image.convert('RGBA')
        background = Image.new('RGB', image.size, (255, 255, 255))
        background.paste(image, mask=image.split()[-1])
        return background
    return image.convert('RGB')


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------


def main():
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
    workspace_root = os.path.abspath(os.path.join(repo_root, '..', '..'))
    default_source = os.path.join(workspace_root, '报价查价系统')

    parser = argparse.ArgumentParser(description='台账 → data/quote 数据集')
    parser.add_argument('--source', default=default_source, help='三份 xlsx 所在目录')
    parser.add_argument('--out', default=os.path.join(repo_root, 'data', 'quote'), help='产物目录')
    args = parser.parse_args()

    if not os.path.isdir(args.source):
        raise SystemExit('找不到台账目录：%s（用 --source 指定）' % args.source)

    items = []
    extract_sale(os.path.join(args.source, SOURCES['sale']), items)
    extract_craft(os.path.join(args.source, SOURCES['craft']), items)
    extract_hardware(os.path.join(args.source, SOURCES['hardware']), items)

    hardware_book, hardware_strings, hardware_sheets = open_book(
        os.path.join(args.source, SOURCES['hardware'])
    )
    anchors = []
    for sheet_name, target in hardware_sheets:
        anchors.extend(parse_anchors(hardware_book, hardware_strings, sheet_name, target))

    bindings, stats = bind_images(anchors, items)
    image_meta, export_stats = export_images(
        hardware_book,
        bindings,
        os.path.join(args.out, 'images'),
        os.path.join(args.out, 'thumbs'),
    )

    for item in items:
        item['rawKey'] = raw_key(item)
        kind, fen, text = price_fields(item.pop('rawPrice'), item.pop('legacyKind'))
        item['priceKind'] = kind
        item['priceFen'] = fen
        item['priceText'] = text

    # 台账里确实有完全同名的行（板式工艺里同品类同名但说明不同的两项）。**不能
    # 去重**：去掉一条，客户问「为什么查不到这一项」就答不上来。给它们编个序号，
    # Node 侧把序号拼进业务键，重导一次序号不变，键也不变。
    occurrence = {}
    duplicates = 0
    for item in items:
        key = item['rawKey']
        seen = occurrence.get(key, 0)
        item['occurrence'] = seen
        occurrence[key] = seen + 1
        if seen > 0:
            duplicates += 1

    images = []
    dropped = 0
    for binding in bindings:
        key = os.path.splitext(os.path.basename(binding['file']))[0]
        if key not in image_meta:
            dropped += 1
            continue
        images.append({**binding, **image_meta[key]})

    payload = {
        'sourceNote': ' / '.join(SOURCES.values()),
        'items': items,
        'images': images,
        'counts': {
            'items': len(items),
            'duplicates': duplicates,
            'images': len(images),
            'imageBindExact': stats['exact'],
            'imageBindFamily': stats['family'],
            'anchors': len(anchors),
            'unusedViews': stats['extras'],
            'exportFailed': len(export_stats['failed']),
            'droppedBindings': dropped,
        },
    }
    payload['fingerprint'] = hashlib.sha256(
        json.dumps(
            [
                (i['rawKey'], i['occurrence'], i['priceKind'], i['priceFen'], i['priceText'])
                for i in items
            ],
            ensure_ascii=False,
        ).encode('utf-8')
    ).hexdigest()

    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, 'dataset.json'), 'w', encoding='utf-8') as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)

    by_source = Counter(item['source'] for item in items)
    print('条目 %d 条（%s）' % (len(items), dict(by_source)))
    print('分类 %d 个' % len({(i['source'], i['category']) for i in items}))
    print(
        '图片 %d 张：精确 %d + 同族继承 %d；锚点 %d 处，附加视图 %d 张未导'
        % (
            len(images),
            stats['exact'],
            stats['family'],
            len(anchors),
            stats['extras'],
        )
    )
    print(
        '原图直通 %d / EMF 重渲染 %d，失败 %d，绑不上模型的 %d'
        % (
            export_stats['passthrough'],
            export_stats['rerendered'],
            len(export_stats['failed']),
            dropped,
        )
    )
    if duplicates:
        print('同名重复行 %d 条（按出现次序编号，不去重）' % duplicates)
    print('指纹 %s' % payload['fingerprint'][:16])
    print('产物：%s' % args.out)


if __name__ == '__main__':
    main()
