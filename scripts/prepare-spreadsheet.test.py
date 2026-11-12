import sys
sys.dont_write_bytecode = True
import importlib.util
import pathlib
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('spreadsheet', pathlib.Path(__file__).with_name('prepare-spreadsheet.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SpreadsheetTests(unittest.TestCase):
    def test_cell_addresses(self):
        self.assertEqual(module.address(0, 0, 27, 39), 'A1:AB40')

    def test_tiles_bound_size_and_cover_hidden_cells(self):
        sizes = [2000] * 13 + [0] * 30
        tiles = list(module.axis_tiles(sizes, 18000, 12))
        self.assertEqual([i for start, end in tiles for i in range(start, end + 1)], list(range(len(sizes))))
        self.assertTrue(all(end - start < 12 for start, end in tiles))
        self.assertTrue(all(sum(sizes[start:end + 1]) <= 18000 for start, end in tiles))
        self.assertEqual(list(module.axis_tiles([30000, 10], 18000, 12)), [(0, 0), (1, 1)])

    def test_original_caches_preserve_zero_errors_and_missing_values(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'input.xlsx'
            with zipfile.ZipFile(path, 'w') as archive:
                archive.writestr('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Budget" r:id="r1"/></sheets></workbook>')
                archive.writestr('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>')
                archive.writestr('xl/worksheets/sheet1.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c r="A1"><f>1-1</f><v>0</v></c><c r="A2" t="e"><f>1/0</f><v>#DIV/0!</v></c><c r="A3"><f>1+1</f></c></row></sheetData></worksheet>')
            self.assertEqual(module.stored_formula_values(path)['Budget'], {
                'A1': {'value': '0', 'type': 'n'}, 'A2': {'value': '#DIV/0!', 'type': 'e'},
                'A3': {'value': None, 'type': 'n'}})

    def test_non_ooxml_does_not_claim_cached_values(self):
        with tempfile.NamedTemporaryFile() as file:
            self.assertEqual(module.stored_formula_values(file.name), {})


if __name__ == '__main__':
    unittest.main()
