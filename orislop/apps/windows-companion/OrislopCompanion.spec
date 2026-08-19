# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

root = Path(SPECPATH).parents[1]

a = Analysis(
    [str(root / "apps" / "windows-companion" / "orislop_companion.py")],
    pathex=[str(root), str(root / "apps" / "detector-bridge")],
    binaries=[],
    datas=[
        (str(root / "configs"), "configs"),
        (str(root / "models"), "models"),
        (str(root / "apps" / "detector-bridge" / "third_party"), "apps/detector-bridge/third_party"),
    ] + collect_data_files("faster_whisper"),
    hiddenimports=["spatial_runtime", "fact_check_service", "cloud_beta"] + collect_submodules("faster_whisper"),
    excludes=["tkinter"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="orislop-companion",
    console=False,
    disable_windowed_traceback=False,
)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="orislop-companion")
