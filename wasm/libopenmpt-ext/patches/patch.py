#!/usr/bin/env python3
"""Add a public accessor to openmpt::module_impl so the shim can reach the
otherwise-protected CSoundFile. Idempotent — safe to run on every build.

This is the ONLY source change to OpenMPT (besides appending src/shim.cpp to
libopenmpt_c.cpp). Run from the OpenMPT checkout root."""
import sys
import pathlib

HDR = pathlib.Path("libopenmpt/libopenmpt_impl.hpp")
MARKER = "shim_get_sndfile"
ACCESSOR = (
    "public:\n"
    "\t// scene shim: reach the internal CSoundFile for sample extraction.\n"
    "\tOpenMPT::CSoundFile * shim_get_sndfile() const { return m_sndFile.get(); }\n"
)
CLASS_END = "}; // class module_impl"


def main() -> int:
    text = HDR.read_text()
    if MARKER in text:
        print("patch.py: accessor already present, skipping")
        return 0
    if CLASS_END not in text:
        print(f"patch.py: ERROR — could not find '{CLASS_END}' in {HDR}", file=sys.stderr)
        return 1
    text = text.replace(CLASS_END, ACCESSOR + CLASS_END, 1)
    HDR.write_text(text)
    print(f"patch.py: added module_impl::shim_get_sndfile() to {HDR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
