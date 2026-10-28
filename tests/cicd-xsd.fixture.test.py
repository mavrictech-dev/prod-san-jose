import hashlib, json, runpy, shutil, tempfile, unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
class CiXsd(unittest.TestCase):
    def test_extracts_pinned_schema_in_fresh_disposable_directory(self):
        with tempfile.TemporaryDirectory(prefix='factuez-ci-xsd-') as tmp:
            root=Path(tmp);(root/'tests').mkdir();assets=root/'services/sunat-service/assets/sunat';assets.mkdir(parents=True)
            script=root/'tests/prepare-ci-xsd.py';shutil.copyfile(ROOT/'tests/prepare-ci-xsd.py',script)
            shutil.copyfile(ROOT/'services/sunat-service/assets/sunat/xsd-20220228.zip',assets/'xsd-20220228.zip')
            runpy.run_path(str(script));self.assertTrue((root/'tmp/sunat-schema/ubl21-browser/Archivos XSD/2.1/maindoc/UBL-CreditNote-2.1.xsd').is_file())
            with self.assertRaisesRegex(ValueError,'NEW_XSD'):runpy.run_path(str(script))
    def test_rejects_modified_archive_without_extracting(self):
        with tempfile.TemporaryDirectory(prefix='factuez-ci-xsd-') as tmp:
            root=Path(tmp);(root/'tests').mkdir();assets=root/'services/sunat-service/assets/sunat';assets.mkdir(parents=True)
            script=root/'tests/prepare-ci-xsd.py';shutil.copyfile(ROOT/'tests/prepare-ci-xsd.py',script);(assets/'xsd-20220228.zip').write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError,'PINNED_XSD'):runpy.run_path(str(script))
            self.assertFalse((root/'tmp').exists())
if __name__=='__main__':unittest.main()
