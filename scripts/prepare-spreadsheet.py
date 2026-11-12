"""Read a workbook through an isolated LibreOffice process; never save the source.

Invoked by Studyloom with a secrets-free environment and a process-group timeout.
Requires the deployment packages libreoffice-calc and python3-uno.
"""
import json
import math
import pathlib
import subprocess
import sys
import time
import uuid
import zipfile
import posixpath
import xml.etree.ElementTree as ET

MAX_CELLS = 200_000
MAX_TILES = 2000


def column_name(index):
    result = ''
    while index >= 0:
        result = chr(65 + index % 26) + result
        index = index // 26 - 1
    return result


def address(c1, r1, c2, r2):
    return f'{column_name(c1)}{r1 + 1}:{column_name(c2)}{r2 + 1}'


def axis_tiles(sizes, limit, max_count):
    """Bound tiles by physical size as well as cell count; hidden cells still belong to a tile."""
    start, length = 0, 0
    for i, size in enumerate(sizes):
        if i > start and (length + size > limit or i - start >= max_count):
            yield start, i - 1
            start, length = i, 0
        length += size
    if sizes:
        yield start, len(sizes) - 1


def finite(value):
    return value if math.isfinite(value) else None


def stored_formula_values(source):
    """Read OOXML formula caches without recalculating or trusting external relationships."""
    if not zipfile.is_zipfile(source):
        return {}
    ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
          'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
    with zipfile.ZipFile(source) as archive:
        if 'xl/workbook.xml' not in archive.namelist():
            return {}
        def xml(name):
            if archive.getinfo(name).file_size > 32 * 1024 * 1024:
                raise RuntimeError('Workbook XML exceeds the extraction limit.')
            data = archive.read(name)
            if b'<!DOCTYPE' in data or b'<!ENTITY' in data:
                raise RuntimeError('Workbook XML declarations are unsupported.')
            return ET.fromstring(data)
        relationships = {e.attrib['Id']: e.attrib['Target']
                         for e in xml('xl/_rels/workbook.xml.rels')
                         if e.attrib.get('TargetMode') != 'External'}
        result = {}
        for sheet in xml('xl/workbook.xml').findall('s:sheets/s:sheet', ns):
            target = relationships.get(sheet.attrib.get('{' + ns['r'] + '}id'))
            if not target:
                continue
            path = posixpath.normpath(target.lstrip('/') if target.startswith('/') else 'xl/' + target)
            if not path.startswith('xl/worksheets/'):
                result[sheet.attrib['name']] = {}
                continue
            values = {}
            for cell in xml(path).findall('.//s:sheetData/s:row/s:c', ns):
                if cell.find('s:f', ns) is not None:
                    values[cell.attrib['r']] = {'value': cell.findtext('s:v', default=None, namespaces=ns),
                                               'type': cell.attrib.get('t', 'n')}
            result[sheet.attrib['name']] = values
        return result


def main(source, output):
    import uno
    import unohelper
    from com.sun.star.task import XInteractionHandler

    class RejectInteraction(unohelper.Base, XInteractionHandler):
        def handle(self, request):
            for continuation in request.getContinuations():
                if continuation.queryInterface(uno.getTypeByName('com.sun.star.task.XInteractionAbort')):
                    continuation.select()
                    return

    def prop(name, value):
        p = uno.createUnoStruct('com.sun.star.beans.PropertyValue')
        p.Name, p.Value = name, value
        return p

    output = pathlib.Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    source = pathlib.Path(source).resolve()
    stored_values = stored_formula_values(source)
    pipe = 'studyloom_' + uuid.uuid4().hex
    profile = output / 'office-profile'
    process = subprocess.Popen([
        'libreoffice', '--headless', '--norestore', '--nodefault', '--nofirststartwizard',
        '-env:UserInstallation=' + profile.as_uri(),
        '--accept=pipe,name=' + pipe + ';urp;StarOffice.ServiceManager',
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    desktop = document = None
    try:
        local = uno.getComponentContext()
        resolver = local.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver', local)
        deadline = time.monotonic() + 30
        while True:
            try:
                context = resolver.resolve('uno:pipe,name=' + pipe + ';urp;StarOffice.ComponentContext')
                break
            except Exception:
                if process.poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError('LibreOffice spreadsheet service did not start.')
                time.sleep(0.1)
        desktop = context.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop', context)
        document = desktop.loadComponentFromURL(source.as_uri(), '_blank', 0, (
            prop('Hidden', True), prop('ReadOnly', True),
            prop('MacroExecutionMode', uno.getConstantByName('com.sun.star.document.MacroExecMode.NEVER_EXECUTE')),
            prop('UpdateDocMode', uno.getConstantByName('com.sun.star.document.UpdateDocMode.NO_UPDATE')),
            prop('InteractionHandler', RejectInteraction()),
        ))
        if document is None:
            raise RuntimeError('Workbook could not be opened (possibly encrypted or unsupported).')
        if not document.supportsService('com.sun.star.sheet.SpreadsheetDocument'):
            (output / 'manifest.json').write_text(json.dumps({'spreadsheet': False, 'units': []}))
            return
        if stored_values and set(stored_values) != set(document.Sheets.getElementNames()):
            raise RuntimeError('LibreOffice did not preserve all original workbook sheets.')
        document.enableAutomaticCalculation(False)
        names = [{'name': name, 'expression': document.NamedRanges.getByName(name).getContent()}
                 for name in document.NamedRanges.getElementNames()]
        if len(json.dumps(names)) > 100_000:
            raise RuntimeError('Workbook named ranges exceed the extraction limit.')
        for i in range(document.Sheets.getCount()):
            document.Sheets.getByIndex(i).setPrintAreas(())
        units = []
        cell_count = 0
        for sheet_index in range(document.Sheets.getCount()):
            sheet = document.Sheets.getByIndex(sheet_index)
            hidden_sheet = not sheet.IsVisible
            sheet.IsVisible = True
            cursor = sheet.createCursor()
            cursor.gotoEndOfUsedArea(False)
            end = cursor.getRangeAddress()
            last_col, last_row = end.EndColumn, end.EndRow
            # Include drawing objects outside the used cell area, including chart-only sheets.
            shapes = sheet.getDrawPage()
            right = bottom = 0
            for i in range(shapes.getCount()):
                shape = shapes.getByIndex(i)
                right = max(right, shape.Position.X + shape.Size.Width)
                bottom = max(bottom, shape.Position.Y + shape.Size.Height)
            widths, heights = [], []
            hidden_cols, hidden_rows = set(), set()
            for items, collection, target, last, size_prop, cap, hidden in [
                (widths, sheet.Columns, right, last_col, 'Width', 512, hidden_cols),
                (heights, sheet.Rows, bottom, last_row, 'Height', 20000, hidden_rows),
            ]:
                total = 0
                for i in range(cap):
                    item = collection.getByIndex(i)
                    if not item.IsVisible:
                        hidden.add(i)
                        item.IsVisible = True
                    size = getattr(item, size_prop)
                    items.append(size)
                    total += size
                    if i >= last and total >= target:
                        break
                else:
                    raise RuntimeError('Workbook dimensions exceed the extraction limit.')
            cell_count += len(widths) * len(heights)
            if cell_count > MAX_CELLS:
                raise RuntimeError('Workbook exceeds the 200,000-cell extraction limit; split it into smaller workbooks.')
            charts = []
            for name in sheet.Charts.getElementNames():
                chart = sheet.Charts.getByName(name)
                charts.append({'name': name, 'sourceRanges': [
                    {'sheet': document.Sheets.getByIndex(r.Sheet).Name,
                     'range': address(r.StartColumn, r.StartRow, r.EndColumn, r.EndRow)}
                    for r in chart.getRanges()]})
            style = document.StyleFamilies.getByName('PageStyles').getByName(sheet.PageStyle)
            for name, value in {'Width': 21000, 'Height': 29700, 'LeftMargin': 500,
                                'RightMargin': 500, 'TopMargin': 500, 'BottomMargin': 500,
                                'HeaderIsOn': False, 'FooterIsOn': False,
                                'PrintCharts': True, 'PrintObjects': True, 'PrintDrawing': True,
                                'PrintFormulas': False, 'PrintZeroValues': True,
                                'ScaleToPagesX': 1, 'ScaleToPagesY': 1}.items():
                style.setPropertyValue(name, value)
            sheet.setPrintTitleRows(False)
            sheet.setPrintTitleColumns(False)
            formats = document.NumberFormats
            for r1, r2 in axis_tiles(heights, 22000, 40):
                for c1, c2 in axis_tiles(widths, 18000, 12):
                    if len(units) >= MAX_TILES:
                        raise RuntimeError('Workbook exceeds the 2,000-region extraction limit.')
                    cells, merged, errors = [], set(), []
                    for row in range(r1, r2 + 1):
                        for col in range(c1, c2 + 1):
                            cell = sheet.getCellByPosition(col, row)
                            merge_cursor = sheet.createCursorByRange(sheet.getCellRangeByPosition(col, row, col, row))
                            merge_cursor.collapseToMergedArea()
                            m = merge_cursor.getRangeAddress()
                            if m.StartColumn != m.EndColumn or m.StartRow != m.EndRow:
                                merged.add(address(m.StartColumn, m.StartRow, m.EndColumn, m.EndRow))
                            if cell.getType().value == 'EMPTY':
                                continue
                            cell_address = f'{column_name(col)}{row + 1}'
                            record = {'address': cell_address, 'kind': cell.getType().value,
                                      'display': cell.getString(), 'formula': cell.getFormula() if cell.getType().value == 'FORMULA' else None,
                                      'engineValue': finite(cell.getValue()) if cell.getType().value != 'TEXT' else None,
                                      'numberFormat': formats.getByKey(cell.NumberFormat).FormatString,
                                      'hidden': row in hidden_rows or col in hidden_cols}
                            if cell.getType().value == 'FORMULA':
                                record['originalCache'] = stored_values.get(sheet.Name, {}).get(cell_address)
                            error = cell.getError()
                            if error:
                                record['error'] = error
                                errors.append(cell_address)
                            cells.append(record)
                    if not cells and shapes.getCount() == 0 and not merged:
                        continue
                    cell_range = sheet.getCellRangeByPosition(c1, r1, c2, r2)
                    range_name = address(c1, r1, c2, r2)
                    # Quoted sheet names are unambiguous even with punctuation or apostrophes.
                    locator = "sheet:'" + sheet.Name.replace("'", "''") + "'!" + range_name
                    index = len(units)
                    pdf = output / f'region-{index}.pdf'
                    document.CurrentController.setActiveSheet(sheet)
                    document.CurrentController.select(cell_range)
                    sheet.setPrintAreas((cell_range.getRangeAddress(),))
                    document.storeToURL(pdf.as_uri(), (prop('FilterName', 'calc_pdf_Export'), prop('Overwrite', True),
                        prop('FilterData', (prop('Selection', cell_range), prop('ExportFormFields', False))),))
                    sheet.setPrintAreas(())
                    limitations = []
                    if any(c['kind'] == 'FORMULA' and (c.get('originalCache') is None or c['originalCache']['value'] is None) for c in cells):
                        limitations.append('Original formula caches are unavailable for some cells; results are LibreOffice imported values.')
                    if any(c['formula'] and ('file:' in c['formula'].lower() or '[' in c['formula'] or 'WEBSERVICE(' in c['formula'].upper()) for c in cells):
                        limitations.append('Formula references may depend on external data; external updates are disabled.')
                    if errors:
                        limitations.append('LibreOffice reports formula errors at ' + ', '.join(errors))
                    data = {'sheet': sheet.Name, 'hiddenSheet': hidden_sheet, 'range': range_name,
                            'cells': cells, 'mergedRanges': sorted(merged), 'namedRanges': names, 'charts': charts,
                            'drawingObjectCount': shapes.getCount(),
                            'rendering': 'Hidden sheets, rows and columns are shown for review; original visibility is recorded in metadata. Original print areas are ignored.',
                            'valueProvenance': 'LibreOffice imported values, not verified original cached results. No explicit recalculation was requested; import may recalculate. External links and macros are disabled.',
                            'limitations': limitations}
                    text = json.dumps(data, ensure_ascii=False, allow_nan=False)
                    if len(text) > 150_000:
                        raise RuntimeError('Spreadsheet region exceeds the review text limit.')
                    units.append({'locator': locator, 'text': text, 'pdf': f'converted/workbook/region-{index}.pdf', 'limitations': limitations})
        (output / 'manifest.json').write_text(json.dumps({'spreadsheet': True, 'units': units}, ensure_ascii=False), encoding='utf-8')
    finally:
        try:
            if document is not None:
                document.close(True)
            if desktop is not None:
                desktop.terminate()
        except Exception:
            pass
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
